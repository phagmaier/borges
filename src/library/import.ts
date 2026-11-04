import { randomUUID } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { basename } from "node:path";
import { copyToNewFile, publishFile } from "../storage/files.ts";
import { resolveLibraryPath } from "../storage/paths.ts";
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

// Minimal internal "add file as new book" on top of the operation protocol
// (see recovery.ts for the states). Duplicate handling, metadata/cover
// extraction, sections and batch import belong to the milestone-four import
// service; this is the publication path they will share.

export type ImportErrorCode =
  | "unsupported"
  | "mismatched"
  | "unreadable"
  | "storage-failed";

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImportError";
    this.code = code;
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
  const checkpoint = options.checkpoint ?? (() => {});
  const { root, database } = library;
  const sourceName = basename(sourcePath);
  const claimed = formatFromName(sourceName);
  if (!claimed) {
    throw new ImportError(
      "unsupported",
      `${sourceName} is not a PDF or EPUB file (expected a .pdf or .epub name).`,
    );
  }
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
        () => checkpoint("copying"),
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
    immediate(database, () => {
      const at = now();
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
    };
  } catch (error) {
    if (committed) throw error;
    const failure =
      error instanceof ImportError ? error : storageError(error, sourceName);
    await rollBackAfterFailure(library, operationId, failure, now);
    throw failure;
  }
}

async function openSource(path: string, name: string): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
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
