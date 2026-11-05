import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  copyToNewFile,
  digestFile,
  type FileDigest,
  publishFile,
  sameContents,
} from "../storage/files.ts";
import {
  resolveExistingLibraryPath,
  resolveLibraryPath,
} from "../storage/paths.ts";
import { immediate } from "../storage/transaction.ts";
import { parseMetadataEdit } from "./books.ts";
import { inspectCoverImage } from "./cover-image.ts";
import {
  type DuplicateChoice,
  type DuplicatePrompt,
  metadataDuplicates,
} from "./duplicates.ts";
import { type InspectBook, InspectionError } from "./extraction.ts";
import {
  type BookFormat,
  formatFromName,
  sniffFormat,
  titleFromName,
} from "./formats.ts";
import { getBook } from "./query.ts";
import {
  type LibraryHandle,
  readOperation,
  rollBackOperation,
  setOperationState,
} from "./recovery.ts";
import {
  checkReplacementTarget,
  commitReplacement,
  type ReplacementTarget,
} from "./replacement.ts";
import { foldKey, requireId } from "./rules.ts";
import {
  type RestoredImportInfo,
  type TrashCandidate,
  type TrashChoice,
  type TrashMatchPrompt,
  trashCandidates,
} from "./trash-matches.ts";

// "Add file as new book" on top of the operation protocol (see recovery.ts
// for the states). Byte-identical live content is skipped, the book can join
// a section in the same commit, and an abort signal cancels before the
// commit. Batch import (import-batch.ts) runs files through this one at a
// time. Production import supplies a sandboxed content inspector; protocol
// tests and catalog seeds can exercise publication independently of parsers.

export type ImportErrorCode =
  | "unsupported"
  | "mismatched"
  | "protected"
  | "invalid-content"
  | "resource-limit"
  | "unreadable"
  | "restored"
  | "skipped"
  | "duplicate"
  | "cancelled"
  | "storage-failed";

/** The live entry that already holds byte-identical content. */
export interface ExistingBook {
  bookId: string;
  title: string;
  archived: boolean;
}

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly existing: ExistingBook | undefined;
  readonly restored: RestoredImportInfo | undefined;
  constructor(
    code: ImportErrorCode,
    message: string,
    options?: ErrorOptions & {
      existing?: ExistingBook;
      restored?: RestoredImportInfo;
    },
  ) {
    super(message, options);
    this.name = "ImportError";
    this.code = code;
    this.existing = options?.existing;
    this.restored = options?.restored;
  }
}

/** Protocol points, in order. Tests inject failures and process kills here. */
export type ImportStep =
  | "pending"
  | "copying"
  | "validated"
  | "cover-pending"
  | "cover-staged"
  | "cover-renamed"
  | "cover-published"
  | "staged"
  | "renamed"
  | "published"
  | "committing"
  | "committed";

export interface AddBookOptions {
  /** Production content validation/extraction. Omit only for storage tests
   * and controlled catalog seeds which isolate the publication protocol. */
  inspect?: InspectBook;
  /** Explicit restoration uses these internal publication constraints. */
  skipTrashMatch?: boolean;
  chooseTrash?: (prompt: TrashMatchPrompt) => Promise<TrashChoice>;
  restoreTrash?: (
    candidate: TrashCandidate,
    mode: "book" | "current" | "separate",
  ) => Promise<RestoredImportInfo>;
  originalFileName?: string;
  expectedDigest?: FileDigest;
  beforeNewBookCommit?: () => void;
  chooseDuplicate?: (prompt: DuplicatePrompt) => Promise<DuplicateChoice>;
  beforeReplacement?: (bookId: string) => void | Promise<void>;
  now?: () => number;
  /** Called at each protocol point; throwing simulates a failure there. */
  checkpoint?: (step: ImportStep) => void;
  /** Join this section in the catalog commit. If it was deleted meanwhile,
   * the book is still added (unfiled) and `joinedSection` is false. */
  sectionId?: string | null;
  /** Aborting before the catalog commit rolls the copy back ("cancelled"). */
  signal?: AbortSignal;
  /** Awaited after each copied chunk (development-only throttling for
   * native cancellation tests). */
  pace?: () => Promise<void>;
}

export interface AddedBook {
  bookId: string;
  revisionId: string;
  operationId: string;
  format: BookFormat;
  title: string;
  /** Root-relative path of the published immutable bytes. */
  path: string;
  sha256: string;
  size: number;
  /** Whether the requested section was joined (false when none requested). */
  joinedSection: boolean;
  replaced: boolean;
  warnings: string[];
}

/**
 * Copy one PDF/EPUB into managed storage and create an Unread book for it.
 * The source is only read. On any failure before the catalog commit the copy
 * is rolled back (or retained and reported if it cannot be verified), and no
 * book refers to partial bytes.
 */
export async function addFileAsNewBook(
  library: LibraryHandle,
  sourcePath: string,
  options: AddBookOptions = {},
): Promise<AddedBook> {
  return publishBookFile(library, sourcePath, options);
}

export interface ReplaceBookOptions extends Omit<AddBookOptions, "sectionId"> {
  /** Recheck the revision selected before the file chooser, if supplied. */
  expectedRevisionId?: string;
  beforeCommit?: () => void | Promise<void>;
}

/** Publish a new immutable revision; preserve the target book and old location. */
export async function replaceBookFile(
  library: LibraryHandle,
  bookId: unknown,
  sourcePath: string,
  options: ReplaceBookOptions = {},
): Promise<AddedBook> {
  const id = requireId(bookId, "book");
  getBook(library.database, id);
  const current = library.database
    .prepare("SELECT current_revision_id FROM books WHERE id = ?")
    .get(id);
  const target: ReplacementTarget = {
    bookId: id,
    revisionId:
      options.expectedRevisionId ?? String(current?.current_revision_id),
    beforeCommit: options.beforeCommit,
  };
  checkReplacementTarget(library.database, target);
  return publishBookFile(library, sourcePath, options, target);
}

async function publishBookFile(
  library: LibraryHandle,
  sourcePath: string,
  options: AddBookOptions,
  target?: ReplacementTarget,
): Promise<AddedBook> {
  const now = options.now ?? Date.now;
  const sourceName = options.originalFileName ?? basename(sourcePath);
  const { signal } = options;
  const checkpoint = (step: ImportStep) => {
    options.checkpoint?.(step);
    if (signal?.aborted && step !== "committed")
      throw new ImportError(
        "cancelled",
        `Import of ${sourceName} was cancelled; no book was created.`,
      );
  };
  const { root, database } = library;
  const claimed = formatFromName(sourceName);
  if (!claimed) {
    throw new ImportError(
      "unsupported",
      `${sourceName} is not a PDF or EPUB file (expected a .pdf or .epub name).`,
    );
  }
  if (signal?.aborted)
    throw new ImportError(
      "cancelled",
      `Import of ${sourceName} was cancelled before it started.`,
    );
  const source = await openSource(sourcePath, sourceName);

  const operationId = randomUUID();
  let bookId = target?.bookId ?? randomUUID();
  const revisionId = randomUUID();
  const stagedPath = `staging/${operationId}.partial`;
  const publishedPath = `files/${revisionId}.${claimed}`;
  let title = titleFromName(sourceName);
  let extractedTitle: string | null = null;
  let authors: string[] = [];
  let subjects: string[] = [];
  const warnings: string[] = [];
  let coverPath: string | null = null;
  const coverOperationId = `${operationId}-cover`;
  try {
    const at = now();
    immediate(database, () =>
      database
        .prepare(
          `INSERT INTO recovery_operations (id, kind, state, book_id,
             revision_id, staged_path, detail, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          target ? "replace" : "import",
          bookId,
          revisionId,
          stagedPath,
          JSON.stringify({ sourceName }),
          at,
          at,
        ),
    );
  } catch (error) {
    await source.close();
    throw storageError(error);
  }

  let committed = false;
  try {
    let digest: Awaited<ReturnType<typeof copyToNewFile>>;
    try {
      checkpoint("pending");
      digest = await copyToNewFile(
        source,
        resolveLibraryPath(root, stagedPath),
        async () => {
          checkpoint("copying");
          await options.pace?.(); // A cancel here is seen at the next point.
        },
      );
    } finally {
      await source.close();
    }
    if (
      options.expectedDigest &&
      (digest.sha256 !== options.expectedDigest.sha256 ||
        digest.size !== options.expectedDigest.size)
    )
      throw new ImportError(
        "invalid-content",
        "The retained file changed while copying. Nothing was restored.",
      );
    const actual = await sniffFormat(resolveLibraryPath(root, stagedPath));
    if (actual !== claimed) {
      throw new ImportError(
        actual ? "mismatched" : "unsupported",
        actual
          ? `${sourceName} is named as ${label(claimed)} but contains ${label(actual)} data.`
          : `${sourceName} does not contain ${label(claimed)} data.`,
      );
    }
    immediate(database, () =>
      setOperationState(
        database,
        operationId,
        "staged",
        { publishedPath, detail: { ...digest, format: claimed, title } },
        now(),
      ),
    );
    const existing = await identicalLiveBook(
      library,
      digest,
      resolveLibraryPath(root, stagedPath),
      target?.bookId,
    );
    if (existing) throw duplicateOf(sourceName, existing);
    if (!target && !options.skipTrashMatch) {
      const candidates = trashCandidates(database, digest);
      if (candidates.length) {
        if (!options.chooseTrash || !options.restoreTrash)
          throw new ImportError(
            "skipped",
            `${sourceName} matches content in Trash; choose restore/reuse or cancel.`,
          );
        const choice = await options.chooseTrash({
          name: sourceName,
          candidates,
        });
        checkpoint("staged");
        if (choice.action === "cancel")
          throw new ImportError(
            "skipped",
            `${sourceName} was not imported; its matching Trash entry was kept.`,
          );
        const candidate = candidates.find((c) => c.entryId === choice.entryId);
        if (
          !candidate ||
          !["book", "current", "separate"].includes(choice.mode) ||
          (choice.mode === "book" && candidate.kind !== "book") ||
          (choice.mode === "current" &&
            (candidate.kind !== "revision" || candidate.ownerDeleted))
        )
          throw new ImportError(
            "skipped",
            "Choose a matching Trash entry and an available restore action.",
          );
        const current = trashCandidates(database, digest).find(
          (c) => c.entryId === candidate.entryId,
        );
        if (
          !current ||
          current.revisionId !== candidate.revisionId ||
          current.currentRevisionId !== candidate.currentRevisionId ||
          current.ownerDeleted !== candidate.ownerDeleted
        )
          throw new ImportError(
            "skipped",
            "The matching Trash entry changed. Import this file again to choose its current state.",
          );
        const restored = await options.restoreTrash(candidate, choice.mode);
        throw new ImportError(
          "restored",
          `Restored/reused “${restored.title}” from Trash.${restored.warnings.map((w) => ` ${w}`).join("")}`,
          { restored },
        );
      }
    }
    if (options.inspect) {
      const extracted = await options.inspect(
        resolveLibraryPath(root, stagedPath),
        claimed,
        signal,
      );
      checkpoint("validated");
      warnings.push(...extracted.warnings);
      // Validate each optional field independently. Bad metadata must not
      // discard other useful fields or make a parseable book fail import.
      for (const field of ["title", "authors", "subjects"] as const) {
        try {
          const value =
            field === "title" && !extracted.title?.trim()
              ? {}
              : { [field]: extracted[field] };
          const clean = parseMetadataEdit(value);
          if (clean.title) extractedTitle = title = clean.title;
          if (clean.authors) authors = clean.authors;
          if (clean.subjects) subjects = clean.subjects;
        } catch {
          warnings.push(
            `${field} metadata could not be extracted; a fallback was used.`,
          );
        }
      }
      if (!target) {
        const candidates = metadataDuplicates(
          database,
          extractedTitle,
          authors,
        );
        if (candidates.length) {
          if (!options.chooseDuplicate)
            throw new ImportError(
              "skipped",
              `${sourceName} matches existing metadata; an explicit import choice is required.`,
            );
          const choice = await options.chooseDuplicate({
            name: sourceName,
            title,
            authors,
            candidates,
          });
          checkpoint("validated");
          if (choice.action === "skip")
            throw new ImportError(
              "skipped",
              `${sourceName} was skipped by choice.`,
            );
          if (choice.action === "replace") {
            const candidate = candidates.find(
              (c) => c.bookId === choice.bookId,
            );
            if (!candidate)
              throw new ImportError(
                "skipped",
                "Choose a specific matching book to replace.",
              );
            target = {
              bookId: candidate.bookId,
              revisionId: candidate.revisionId,
              beforeCommit: () => options.beforeReplacement?.(candidate.bookId),
            };
            checkReplacementTarget(database, target);
            bookId = target.bookId;
            // Adopt the selected target before any cover publication. Startup
            // can now reconcile this operation exactly like manual replacement.
            immediate(database, () =>
              database
                .prepare(
                  "UPDATE recovery_operations SET kind = 'replace', book_id = ? WHERE id = ?",
                )
                .run(bookId, operationId),
            );
          } else if (choice.action !== "keep-both") {
            throw new ImportError(
              "skipped",
              "The duplicate choice is invalid.",
            );
          }
        }
      }
      if (extracted.cover) {
        try {
          coverPath = await publishExtractedCover(
            library,
            bookId,
            coverOperationId,
            Buffer.from(extracted.cover),
            checkpoint,
            now,
          );
        } catch (error) {
          await rollBackAfterFailure(
            library,
            coverOperationId,
            storageError(error, sourceName),
            now,
          );
          if (signal?.aborted) checkpoint("validated");
          warnings.push(
            "Cover could not be stored; a placeholder will be used.",
          );
        }
      }
    }
    checkpoint("staged");
    await publishFile(
      resolveLibraryPath(root, stagedPath),
      resolveLibraryPath(root, publishedPath),
    );
    checkpoint("renamed");
    immediate(database, () =>
      setOperationState(database, operationId, "published", {}, now()),
    );
    checkpoint("published");
    let joinedSection = false;
    if (target) {
      checkReplacementTarget(database, target);
      await target.beforeCommit?.();
    }
    immediate(database, () => {
      const at = now();
      if (!target) options.beforeNewBookCommit?.();
      // Recheck against the committed catalog: content that became live
      // since the comparison above is still a duplicate.
      const existing = liveBooksWithDigest(database, digest, target?.bookId)[0];
      if (existing) throw duplicateOf(sourceName, existing);
      if (
        !target &&
        !options.skipTrashMatch &&
        trashCandidates(database, digest).length
      )
        throw new ImportError(
          "skipped",
          "This content became available in Trash during import. Import again to choose restore/reuse or cancel.",
        );
      if (!target)
        database
          .prepare(
            "INSERT INTO books (id, current_revision_id, title, cover_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(bookId, revisionId, title, coverPath, at, at);
      database
        .prepare(
          `INSERT INTO revisions (id, book_id, format, path, sha256, size,
             original_filename, extracted_title, extracted_authors, extracted_subjects,
             extracted_cover_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          bookId,
          claimed,
          publishedPath,
          digest.sha256,
          digest.size,
          sourceName,
          extractedTitle,
          JSON.stringify(authors),
          JSON.stringify(subjects),
          coverPath,
          at,
        );
      if (target) {
        title = commitReplacement(
          database,
          target,
          {
            revisionId,
            format: claimed,
            title: extractedTitle,
            authors,
            subjects,
            coverPath,
          },
          at,
        );
      } else {
        const authorInsert = database.prepare(
          "INSERT INTO book_authors (book_id, position, name) VALUES (?, ?, ?)",
        );
        authors.forEach((name, position) => {
          authorInsert.run(bookId, position, name);
        });
        const subjectInsert = database.prepare(
          "INSERT INTO book_subjects (book_id, label, label_key) VALUES (?, ?, ?)",
        );
        for (const label of subjects)
          subjectInsert.run(bookId, label, foldKey(label));
      }
      if (coverPath)
        setOperationState(database, coverOperationId, "committed", {}, at);
      if (!target && options.sectionId) {
        joinedSection =
          database
            .prepare(
              `INSERT INTO section_memberships (section_id, book_id, added_at)
               SELECT id, ?, ? FROM sections WHERE id = ?`,
            )
            .run(bookId, at, options.sectionId).changes === 1;
      }
      setOperationState(database, operationId, "committed", {}, at);
      checkpoint("committing");
    });
    committed = true;
    checkpoint("committed");
    return {
      bookId,
      revisionId,
      operationId,
      format: claimed,
      title,
      path: publishedPath,
      ...digest,
      joinedSection,
      replaced: !!target,
      warnings,
    };
  } catch (error) {
    if (committed) throw error;
    const failure =
      signal?.aborted &&
      !(error instanceof ImportError && error.code === "restored")
        ? new ImportError("cancelled", `Import of ${sourceName} was cancelled.`)
        : error instanceof ImportError
          ? error
          : error instanceof InspectionError
            ? new ImportError(error.code, `${sourceName}: ${error.message}`, {
                cause: error,
              })
            : storageError(error, sourceName);
    await rollBackAfterFailure(library, coverOperationId, failure, now);
    await rollBackAfterFailure(library, operationId, failure, now);
    if (target)
      throw new ImportError(
        failure.code,
        `${sourceName} could not replace the file (${message(error)}). The previous revision remains current.`,
        { cause: error, existing: failure.existing },
      );
    throw failure;
  }
}

interface LiveCandidate extends ExistingBook {
  path: string;
}

/** Live books (archived included) whose current revision has this digest. */
function liveBooksWithDigest(
  database: DatabaseSync,
  digest: FileDigest,
  exceptBookId?: string,
): LiveCandidate[] {
  return database
    .prepare(
      `SELECT b.id, b.title, b.archived_at, r.path FROM revisions r
       JOIN books b ON b.current_revision_id = r.id
       WHERE r.sha256 = ? AND r.size = ? AND b.deleted_at IS NULL AND b.id <> ?
       ORDER BY b.created_at, b.id`,
    )
    .all(digest.sha256, digest.size, exceptBookId ?? "")
    .map((row) => ({
      bookId: String(row.id),
      title: String(row.title),
      archived: row.archived_at !== null,
      path: String(row.path),
    }));
}

/**
 * The live book whose bytes equal the staged copy. The hash selects
 * candidates; readable candidates are compared byte for byte. A candidate
 * whose managed file cannot be read is trusted on its SHA-256 alone.
 */
async function identicalLiveBook(
  library: LibraryHandle,
  digest: FileDigest,
  staged: string,
  exceptBookId?: string,
): Promise<ExistingBook | null> {
  for (const candidate of liveBooksWithDigest(
    library.database,
    digest,
    exceptBookId,
  )) {
    let same = true;
    try {
      same = await sameContents(
        staged,
        await resolveExistingLibraryPath(library.root, candidate.path),
      );
    } catch {
      // Missing/unreadable managed file: the matching hash decides.
    }
    if (same) return candidate;
  }
  return null;
}

function duplicateOf(
  sourceName: string,
  { bookId, title, archived }: ExistingBook,
): ImportError {
  // Only these fields leave main; the managed path stays private.
  return new ImportError(
    "duplicate",
    `${sourceName} is already in the library as “${title}”${archived ? " (archived)" : ""}; it was skipped.`,
    { existing: { bookId, title, archived } },
  );
}

async function openSource(path: string, name: string): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    // Non-blocking, so a FIFO or device cannot stall the import.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
    return handle;
  } catch (error) {
    await handle?.close();
    throw new ImportError(
      "unreadable",
      `${name} could not be read (${message(error)}).`,
      { cause: error },
    );
  }
}

/**
 * Same rollback as startup reconciliation. If it cannot finish, the record
 * stays open (or failed) and the next startup retries or reports it.
 */
async function rollBackAfterFailure(
  library: LibraryHandle,
  operationId: string,
  failure: ImportError,
  now: () => number,
): Promise<void> {
  try {
    const record = readOperation(library.database, operationId);
    if (record && record.state !== "committed")
      await rollBackOperation(
        library,
        record,
        `stopped (${failure.message})`,
        now,
      );
  } catch {
    // Left for startup reconciliation; the import itself still failed.
  }
}

function storageError(error: unknown, name?: string): ImportError {
  return new ImportError(
    "storage-failed",
    `${name ? `${name} could not be added` : "The import could not be recorded"} (${message(error)}). No book was created.`,
    { cause: error },
  );
}

const label = (format: BookFormat) => (format === "pdf" ? "PDF" : "EPUB");

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A separate cover operation is committed in the book's transaction. Until
 * then startup can roll both publications back independently, including a
 * kill between the two renames. No schema change or unrecorded file exists. */
async function publishExtractedCover(
  library: LibraryHandle,
  bookId: string,
  operationId: string,
  bytes: Buffer,
  checkpoint: (step: ImportStep) => void,
  now: () => number,
): Promise<string> {
  const size = inspectCoverImage(bytes);
  if (
    size.width > 512 ||
    size.height > 768 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid extracted thumbnail");
  const { database, root } = library;
  const stagedPath = `staging/${operationId}.partial`;
  const publishedPath = `covers/${operationId}.png`;
  immediate(database, () =>
    database
      .prepare(`INSERT INTO recovery_operations
    (id, kind, state, book_id, staged_path, detail, created_at, updated_at)
    VALUES (?, 'cover', 'pending', ?, ?, '{}', ?, ?)`)
      .run(operationId, bookId, stagedPath, now(), now()),
  );
  checkpoint("cover-pending");
  const staged = resolveLibraryPath(root, stagedPath);
  await writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
  const handle = await open(staged, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const digest = await digestFile(staged);
  immediate(database, () =>
    setOperationState(
      database,
      operationId,
      "staged",
      {
        publishedPath,
        detail: { ...digest },
      },
      now(),
    ),
  );
  checkpoint("cover-staged");
  await publishFile(staged, resolveLibraryPath(root, publishedPath));
  checkpoint("cover-renamed");
  immediate(database, () =>
    setOperationState(database, operationId, "published", {}, now()),
  );
  checkpoint("cover-published");
  return publishedPath;
}
