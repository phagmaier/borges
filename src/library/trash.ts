import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { resolveExistingLibraryPath } from "../storage/paths.ts";
import { immediate } from "../storage/transaction.ts";
import { getBook } from "./query.ts";
import type { LibraryHandle } from "./recovery.ts";
import { LibraryError, requireId, storage } from "./rules.ts";

export interface TrashEntry {
  id: string;
  kind: "book" | "revision";
  bookId: string;
  revisionId: string;
  currentRevisionId: string;
  ownerDeleted: boolean;
  title: string;
  fileName: string;
  format: "pdf" | "epub";
  status: "unread" | "reading" | "finished";
  archived: boolean;
  trashedAt: number;
  position: string;
  bytes: number;
  fileProblem: boolean;
}
export interface TrashListing {
  entries: TrashEntry[];
  /** Unique readable file/cover bytes referenced by Trash, not a purge estimate. */
  bytes: number;
  unavailableFiles: number;
}
export interface RestoredBook {
  bookId: string;
  missingSections: string[];
  unfiled: boolean;
  archived: boolean;
  warnings: string[];
}
export class RestoreConflict extends LibraryError {
  readonly bookId: string;
  constructor(bookId: string, title: string) {
    super(
      "invalid",
      `Identical content is already live as “${title}”. Use the existing entry; the retained entry remains in Trash.`,
    );
    this.bookId = bookId;
  }
}
interface SectionSnapshot {
  id: string;
  name: string;
}
export type TrashCheckpoint = (step: "committing" | "committed") => void;

/** No filesystem mutation: catalog state and restore context commit together.
 * The coordinator must strictly save, retire and close an open reader first. */
export function deleteBook(
  database: DatabaseSync,
  input: unknown,
  checkpoint?: TrashCheckpoint,
): { id: string } {
  const bookId = requireId(input, "book");
  const id = randomUUID();
  storage(
    () =>
      immediate(database, () => {
        getBook(database, bookId);
        const sections = database
          .prepare(`SELECT s.id, s.name FROM sections s
      JOIN section_memberships m ON m.section_id = s.id WHERE m.book_id = ? ORDER BY s.id`)
          .all(bookId);
        const at = Date.now();
        database
          .prepare(
            "INSERT INTO trash_entries (id, kind, book_id, trashed_at, context) VALUES (?, 'book', ?, ?, ?)",
          )
          .run(id, bookId, at, JSON.stringify({ sections }));
        database
          .prepare(
            "UPDATE books SET deleted_at = ?, updated_at = ?, session_generation = session_generation + 1 WHERE id = ?",
          )
          .run(at, at, bookId);
        checkpoint?.("committing");
      }),
    "write",
  );
  checkpoint?.("committed");
  return { id };
}

async function readableSize(
  library: LibraryHandle,
  path: string,
): Promise<number | null> {
  try {
    const resolved = await resolveExistingLibraryPath(library.root, path);
    const handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      return info.isFile() ? info.size : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function listTrash(library: LibraryHandle): Promise<TrashListing> {
  const rows = storage(
    () =>
      library.database
        .prepare(`SELECT t.id, t.kind, t.book_id, t.trashed_at,
      b.title, b.reading_status, b.archived_at, b.cover_path, b.deleted_at, b.current_revision_id,
      r.id AS revision_id, r.format, r.path, r.original_filename, r.extracted_title, r.extracted_cover_path,
      p.pdf_page, p.epub_section, p.epub_fraction
    FROM trash_entries t JOIN books b ON b.id = t.book_id
    JOIN revisions r ON r.id = coalesce(t.revision_id, b.current_revision_id)
    LEFT JOIN positions p ON p.revision_id = r.id
    ORDER BY t.trashed_at DESC, t.id`)
        .all(),
    "read",
  );
  const sizes = new Map<string, number | null>();
  const size = async (path: string) => {
    if (!sizes.has(path)) sizes.set(path, await readableSize(library, path));
    return sizes.get(path) ?? null;
  };
  const entries: TrashEntry[] = [];
  for (const row of rows) {
    const bytes = await size(String(row.path));
    for (const cover of [
      row.extracted_cover_path,
      row.kind === "book" ? row.cover_path : null,
    ])
      if (cover) await size(String(cover));
    entries.push({
      id: String(row.id),
      kind: row.kind as TrashEntry["kind"],
      bookId: String(row.book_id),
      revisionId: String(row.revision_id),
      currentRevisionId: String(row.current_revision_id),
      ownerDeleted: row.deleted_at !== null,
      title: String(
        row.kind === "book"
          ? row.title
          : row.extracted_title || row.original_filename,
      ),
      fileName: String(row.original_filename),
      format: row.format as TrashEntry["format"],
      status: row.reading_status as TrashEntry["status"],
      archived: row.archived_at !== null,
      trashedAt: Number(row.trashed_at),
      bytes: bytes ?? 0,
      fileProblem: bytes === null,
      position:
        row.pdf_page !== null
          ? `Page ${row.pdf_page}`
          : row.epub_section !== null
            ? `Chapter ${Number(row.epub_section) + 1} · ${Math.round(Number(row.epub_fraction) * 100)}% within chapter`
            : "Beginning",
    });
  }
  return {
    entries,
    bytes: [...sizes.values()].reduce<number>((sum, n) => sum + (n ?? 0), 0),
    unavailableFiles: [...sizes.values()].filter((n) => n === null).length,
  };
}

export async function restoreDeletedBook(
  library: LibraryHandle,
  input: unknown,
  checkpoint?: TrashCheckpoint,
  signal?: AbortSignal,
): Promise<RestoredBook> {
  const id = requireId(input, "Trash entry");
  const { database } = library;
  const find = () =>
    database
      .prepare(`SELECT t.book_id, t.context, r.path, r.id AS revision_id, r.sha256, r.size, b.archived_at
    FROM trash_entries t JOIN books b ON b.id = t.book_id
    JOIN revisions r ON r.id = b.current_revision_id
    WHERE t.id = ? AND t.kind = 'book' AND b.deleted_at IS NOT NULL`)
      .get(id);
  const preview = find();
  if (!preview)
    throw new LibraryError(
      "invalid",
      "This deleted-book entry is no longer in Trash.",
    );
  const fileProblem =
    (await readableSize(library, String(preview.path))) === null;
  const result = storage(
    () =>
      immediate(database, () => {
        if (signal?.aborted)
          throw new LibraryError(
            "invalid",
            "Restoration was cancelled; nothing was restored.",
          );
        const row = find();
        if (!row || row.revision_id !== preview.revision_id)
          throw new LibraryError(
            "invalid",
            "This Trash entry changed. Refresh Trash and try again.",
          );
        const conflict = database
          .prepare(`SELECT b.id, b.title FROM books b JOIN revisions r ON r.id = b.current_revision_id
      WHERE b.deleted_at IS NULL AND r.sha256 = ? AND r.size = ? LIMIT 1`)
          .get(String(row.sha256), Number(row.size));
        if (conflict)
          throw new RestoreConflict(
            String(conflict.id),
            String(conflict.title),
          );
        const context = JSON.parse(String(row.context)) as {
          sections?: SectionSnapshot[];
        };
        if (
          !Array.isArray(context.sections) ||
          context.sections.some(
            (s) => !s || typeof s.id !== "string" || typeof s.name !== "string",
          )
        )
          throw new LibraryError(
            "invalid",
            "The saved section context is damaged. The book remains in Trash.",
          );
        const missingSections: string[] = [];
        for (const section of context.sections) {
          if (
            !database
              .prepare("SELECT 1 FROM sections WHERE id = ?")
              .get(section.id)
          )
            missingSections.push(section.name);
          else
            database
              .prepare(
                "INSERT OR IGNORE INTO section_memberships (section_id, book_id, added_at) VALUES (?, ?, ?)",
              )
              .run(section.id, String(row.book_id), Date.now());
        }
        database
          .prepare(
            "UPDATE books SET deleted_at = NULL, updated_at = ?, session_generation = session_generation + 1 WHERE id = ?",
          )
          .run(Date.now(), String(row.book_id));
        database.prepare("DELETE FROM trash_entries WHERE id = ?").run(id);
        const unfiled = !database
          .prepare("SELECT 1 FROM section_memberships WHERE book_id = ?")
          .get(String(row.book_id));
        checkpoint?.("committing");
        return {
          bookId: String(row.book_id),
          archived: row.archived_at !== null,
          missingSections,
          unfiled,
          warnings: fileProblem
            ? [
                "The catalog entry was restored, but its managed file is missing or unreadable. Use Replace File to repair it.",
              ]
            : [],
        };
      }),
    "write",
  );
  checkpoint?.("committed");
  return result;
}
