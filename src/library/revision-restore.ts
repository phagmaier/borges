import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { digestFile } from "../storage/files.ts";
import { resolveExistingLibraryPath } from "../storage/paths.ts";
import { immediate } from "../storage/transaction.ts";
import { type AddBookOptions, addFileAsNewBook } from "./import.ts";
import { assertNotPurging } from "./purge.ts";
import { getBook } from "./query.ts";
import type { LibraryHandle } from "./recovery.ts";
import { checkReplacementTarget, commitReplacement } from "./replacement.ts";
import { LibraryError, requireId, storage } from "./rules.ts";
import { RestoreConflict, type TrashCheckpoint } from "./trash.ts";
import type { RestoredImportInfo } from "./trash-matches.ts";

export interface RevisionRestoreOptions {
  expectedCurrentId?: string;
  beforeCommit?: (bookId: string) => void;
  signal?: AbortSignal;
  checkpoint?: TrashCheckpoint;
  publicationCheckpoint?: AddBookOptions["checkpoint"];
}

/** Current restoration changes catalog references only. Separate restoration
 * publishes an independent copy, leaving the old revision/location in Trash. */
export async function restoreRevision(
  library: LibraryHandle,
  input: unknown,
  mode: unknown,
  options: RevisionRestoreOptions = {},
): Promise<RestoredImportInfo> {
  const id = requireId(input, "Trash entry");
  if (mode !== "current" && mode !== "separate")
    throw new LibraryError(
      "invalid",
      "Choose current revision or separate book.",
    );
  const { database } = library;
  const find = () =>
    database
      .prepare(`SELECT t.kind, t.book_id, b.current_revision_id, b.deleted_at, r.*
    FROM trash_entries t JOIN books b ON b.id = t.book_id
    JOIN revisions r ON r.id = coalesce(t.revision_id, b.current_revision_id) WHERE t.id = ?`)
      .get(id);
  const preview = find();
  if (!preview)
    throw new LibraryError("invalid", "This entry is no longer in Trash.");
  assertNotPurging(database, String(preview.book_id));
  const conflict = () => {
    const row = database
      .prepare(`SELECT b.id, b.title FROM books b JOIN revisions r ON r.id = b.current_revision_id
      WHERE b.deleted_at IS NULL AND r.sha256 = ? AND r.size = ? LIMIT 1`)
      .get(String(preview.sha256), Number(preview.size));
    if (row) throw new RestoreConflict(String(row.id), String(row.title));
  };
  conflict();
  if (
    mode === "current" &&
    (preview.kind !== "revision" || preview.deleted_at !== null)
  )
    throw new LibraryError(
      "invalid",
      "Restore the deleted book first, or restore this file as a separate book.",
    );
  const target = {
    bookId: String(preview.book_id),
    revisionId:
      options.expectedCurrentId ?? String(preview.current_revision_id),
  };
  const check = () => {
    assertNotPurging(database, String(preview.book_id));
    if (options.signal?.aborted)
      throw new LibraryError(
        "invalid",
        "Restoration was cancelled; nothing was restored.",
      );
    const row = find();
    if (
      !row ||
      row.id !== preview.id ||
      row.current_revision_id !== preview.current_revision_id ||
      row.deleted_at !== preview.deleted_at
    )
      throw new LibraryError(
        "invalid",
        "The Trash entry or its book changed. Refresh Trash and try again.",
      );
    if (mode === "current") checkReplacementTarget(database, target);
    conflict();
  };
  const path = await resolveExistingLibraryPath(
    library.root,
    String(preview.path),
  ).catch(() => {
    throw new LibraryError(
      "invalid",
      "The retained file is missing or unreadable. Its Trash entry was kept.",
    );
  });
  const info = await stat(path);
  if (!info.isFile() || info.size !== Number(preview.size))
    throw new LibraryError(
      "invalid",
      "The retained file is not a regular file of the recorded size. Nothing was restored; its entry was kept.",
    );
  const digest = await digestFile(path);
  if (digest.sha256 !== preview.sha256 || digest.size !== preview.size)
    throw new LibraryError(
      "invalid",
      "The retained file no longer matches its recorded content. Nothing was restored; the file was kept for inspection.",
    );
  check();
  if (mode === "separate") {
    let cover: Uint8Array | null = null;
    const warnings: string[] = [];
    if (preview.extracted_cover_path) {
      try {
        const handle = await open(
          await resolveExistingLibraryPath(
            library.root,
            String(preview.extracted_cover_path),
          ),
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 10 * 1024 * 1024)
            throw new Error("oversized cover");
          cover = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch {
        warnings.push(
          "The retained cover was unavailable; a placeholder was used.",
        );
      }
    }
    const added = await addFileAsNewBook(library, path, {
      skipTrashMatch: true,
      originalFileName: String(preview.original_filename),
      expectedDigest: digest,
      signal: options.signal,
      checkpoint: options.publicationCheckpoint,
      beforeNewBookCommit: check,
      chooseDuplicate: async () => ({ action: "keep-both" }),
      inspect: async () => ({
        title: preview.extracted_title as string | null,
        authors: JSON.parse(String(preview.extracted_authors)) as string[],
        subjects: JSON.parse(String(preview.extracted_subjects)) as string[],
        cover,
        warnings,
      }),
    });
    return {
      bookId: added.bookId,
      title: added.title,
      warnings: [
        ...added.warnings,
        "The earlier file and saved position remain in Trash.",
      ],
    };
  }
  options.beforeCommit?.(target.bookId);
  storage(
    () =>
      immediate(database, () => {
        check();
        commitReplacement(
          database,
          target,
          {
            revisionId: String(preview.id),
            format: preview.format as "pdf" | "epub",
            title: preview.extracted_title as string | null,
            authors: JSON.parse(String(preview.extracted_authors)) as string[],
            subjects: JSON.parse(
              String(preview.extracted_subjects),
            ) as string[],
            coverPath: preview.extracted_cover_path as string | null,
          },
          Date.now(),
        );
        database
          .prepare("UPDATE revisions SET retired_at = NULL WHERE id = ?")
          .run(String(preview.id));
        database.prepare("DELETE FROM trash_entries WHERE id = ?").run(id);
        options.checkpoint?.("committing");
      }),
    "write",
  );
  options.checkpoint?.("committed");
  return {
    bookId: target.bookId,
    title: getBook(database, target.bookId).title,
    warnings: [],
  };
}
