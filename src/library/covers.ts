import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { copyToNewFile, digestFile, publishFile } from "../storage/files.ts";
import {
  resolveExistingLibraryPath,
  resolveLibraryPath,
} from "../storage/paths.ts";
import { immediate } from "../storage/transaction.ts";
import {
  coverToken,
  inspectCoverImage,
  invalidCover,
  MAX_COVER_BYTES,
} from "./cover-image.ts";
import type { ImportStep } from "./import.ts";
import { getBook, readBook } from "./query.ts";
import {
  type LibraryHandle,
  readOperation,
  rollBackOperation,
  setOperationState,
} from "./recovery.ts";
import { LibraryError } from "./rules.ts";

export interface CoverOptions {
  /** Main-process decoder. Returns a bounded PNG thumbnail, or throws. */
  normalize(bytes: Buffer): Buffer;
  checkpoint?(step: ImportStep): void;
}

/** Publish a new immutable cover; the previous cover stays intact. No path
 * from the renderer is accepted: the source comes from main's file dialog. */
export async function setManualCover(
  library: LibraryHandle,
  bookId: unknown,
  sourcePath: string,
  options: CoverOptions,
): Promise<{ path: string }> {
  const { database, root } = library;
  const book = getBook(database, bookId as string);
  const checkpoint = options.checkpoint ?? (() => {});
  const operationId = randomUUID();
  const stagedPath = `staging/${operationId}.partial`;
  const publishedPath = `covers/${operationId}.png`;
  const staged = resolveLibraryPath(root, stagedPath);
  let committed = false;
  let recorded = false;
  try {
    const source = await open(sourcePath, "r");
    try {
      const info = await source.stat();
      if (!info.isFile() || info.size > MAX_COVER_BYTES) throw invalidCover();
      immediate(database, () =>
        database
          .prepare(`INSERT INTO recovery_operations
        (id, kind, state, book_id, staged_path, detail, created_at, updated_at)
        VALUES (?, 'cover', 'pending', ?, ?, ?, ?, ?)`)
          .run(
            operationId,
            book.id,
            stagedPath,
            JSON.stringify({ sourceName: basename(sourcePath) }),
            Date.now(),
            Date.now(),
          ),
      );
      recorded = true;
      checkpoint("pending");
      await copyToNewFile(
        source,
        staged,
        () => checkpoint("copying"),
        MAX_COVER_BYTES,
      );
    } finally {
      await source.close();
    }
    const bytes = await readFile(staged);
    inspectCoverImage(bytes);
    const normalized = options.normalize(bytes);
    const dimensions = inspectCoverImage(normalized);
    if (dimensions.width > 512 || dimensions.height > 768) throw invalidCover();
    const output = await open(staged, "w");
    try {
      await output.writeFile(normalized);
      await output.sync();
    } finally {
      await output.close();
    }
    const digest = await digestFile(staged);
    immediate(database, () =>
      setOperationState(database, operationId, "staged", {
        publishedPath,
        detail: { ...digest },
      }),
    );
    checkpoint("staged");
    await publishFile(staged, resolveLibraryPath(root, publishedPath));
    checkpoint("renamed");
    immediate(database, () =>
      setOperationState(database, operationId, "published"),
    );
    checkpoint("published");
    immediate(database, () => {
      readBook(database, book.id); // Recheck after async copy/dialog work.
      database
        .prepare(
          "UPDATE books SET cover_path = ?, cover_manual = 1, updated_at = ? WHERE id = ?",
        )
        .run(publishedPath, Date.now(), book.id);
      setOperationState(database, operationId, "committed");
      checkpoint("committing");
    });
    committed = true;
    checkpoint("committed");
    return { path: publishedPath };
  } catch (error) {
    if (committed) throw error;
    if (recorded) {
      try {
        const record = readOperation(database, operationId);
        if (record)
          await rollBackOperation(
            library,
            record,
            "stopped before its catalog commit",
          );
      } catch {
        /* Startup retries a rollback that could not finish. */
      }
    }
    if (error instanceof LibraryError) throw error;
    throw new LibraryError(
      "storage-failed",
      `The cover could not be changed (${error instanceof Error ? error.message : String(error)}). The previous cover is unchanged.`,
    );
  }
}

/** Approved current cover only, canonicalized under covers/ rather than just
 * the library root. Missing/unreadable assets are an ordinary placeholder. */
export async function readCover(
  library: LibraryHandle,
  bookId: unknown,
  token: unknown,
): Promise<Uint8Array | null> {
  const book = getBook(library.database, bookId as string);
  const row = library.database
    .prepare("SELECT cover_path FROM books WHERE id = ?")
    .get(book.id);
  const path = row?.cover_path;
  if (
    typeof path !== "string" ||
    typeof token !== "string" ||
    token !== coverToken(path)
  )
    return null;
  try {
    const [directory, target] = await Promise.all([
      resolveExistingLibraryPath(library.root, "covers"),
      resolveExistingLibraryPath(library.root, path),
    ]);
    const inside = relative(directory, target);
    if (!inside || inside.startsWith("..") || inside.startsWith("/"))
      return null;
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_COVER_BYTES) return null;
    const bytes = await readFile(target);
    inspectCoverImage(bytes);
    return bytes;
  } catch {
    return null;
  }
}
