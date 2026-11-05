import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  copyToNewFile,
  type FileDigest,
  publishFile,
  sameContents,
} from "../storage/files.ts";
import {
  resolveExistingLibraryPath,
  resolveLibraryPath,
} from "../storage/paths.ts";
import { immediate } from "../storage/transaction.ts";
import {
  type BookFormat,
  formatFromName,
  sniffFormat,
  titleFromName,
} from "./formats.ts";
import {
  type LibraryHandle,
  readOperation,
  rollBackOperation,
  setOperationState,
} from "./recovery.ts";

// "Add file as new book" on top of the operation protocol (see recovery.ts
// for the states). Byte-identical live content is skipped, the book can join
// a section in the same commit, and an abort signal cancels before the
// commit. Batch import (import-batch.ts) runs files through this one at a
// time; metadata/cover extraction and parse checks arrive with M4-02.

export type ImportErrorCode =
  | "unsupported"
  | "mismatched"
  | "unreadable"
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
  constructor(
    code: ImportErrorCode,
    message: string,
    options?: ErrorOptions & { existing?: ExistingBook },
  ) {
    super(message, options);
    this.name = "ImportError";
    this.code = code;
    this.existing = options?.existing;
  }
}

/** Protocol points, in order. Tests inject failures and process kills here. */
export type ImportStep =
  | "pending"
  | "copying"
  | "staged"
  | "renamed"
  | "published"
  | "committing"
  | "committed";

export interface AddBookOptions {
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
  const now = options.now ?? Date.now;
  const sourceName = basename(sourcePath);
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
  const bookId = randomUUID();
  const revisionId = randomUUID();
  const stagedPath = `staging/${operationId}.partial`;
  const publishedPath = `files/${revisionId}.${claimed}`;
  const title = titleFromName(sourceName);
  try {
    const at = now();
    immediate(database, () =>
      database
        .prepare(
          `INSERT INTO recovery_operations (id, kind, state, book_id,
             revision_id, staged_path, detail, created_at, updated_at)
           VALUES (?, 'import', 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operationId,
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
    );
    if (existing) throw duplicateOf(sourceName, existing);
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
    immediate(database, () => {
      const at = now();
      // Recheck against the committed catalog: content that became live
      // since the comparison above is still a duplicate.
      const existing = liveBooksWithDigest(database, digest)[0];
      if (existing) throw duplicateOf(sourceName, existing);
      database
        .prepare(
          "INSERT INTO books (id, current_revision_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(bookId, revisionId, title, at, at);
      database
        .prepare(
          `INSERT INTO revisions (id, book_id, format, path, sha256, size,
             original_filename, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          bookId,
          claimed,
          publishedPath,
          digest.sha256,
          digest.size,
          sourceName,
          at,
        );
      if (options.sectionId) {
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
    };
  } catch (error) {
    if (committed) throw error;
    const failure =
      error instanceof ImportError ? error : storageError(error, sourceName);
    await rollBackAfterFailure(library, operationId, failure, now);
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
): LiveCandidate[] {
  return database
    .prepare(
      `SELECT b.id, b.title, b.archived_at, r.path FROM revisions r
       JOIN books b ON b.current_revision_id = r.id
       WHERE r.sha256 = ? AND r.size = ? AND b.deleted_at IS NULL
       ORDER BY b.created_at, b.id`,
    )
    .all(digest.sha256, digest.size)
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
): Promise<ExistingBook | null> {
  for (const candidate of liveBooksWithDigest(library.database, digest)) {
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
