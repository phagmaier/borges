import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BookFormat } from "./formats.ts";
import { foldKey, LibraryError } from "./rules.ts";

/** The revision seen when replacement was requested. Rechecked at commit. */
export interface ReplacementTarget {
  bookId: string;
  revisionId: string;
  /** Drain queued engine commands, then flush/retire an open reader before
   * the switch. Rejection prevents the switch; commit rechecks the target. */
  beforeCommit?: () => void | Promise<void>;
}

export function checkReplacementTarget(
  database: DatabaseSync,
  target: ReplacementTarget,
) {
  const book = database
    .prepare(`SELECT b.*, r.format FROM books b
    JOIN revisions r ON r.id = b.current_revision_id
    WHERE b.id = ? AND b.deleted_at IS NULL`)
    .get(target.bookId);
  if (!book || book.current_revision_id !== target.revisionId)
    throw new LibraryError(
      "invalid",
      "The book's file changed while replacement was being prepared. Choose Replace File again.",
    );
  return book;
}

/** Called inside the publication transaction, after the new revision exists.
 * Old files and revision-specific positions stay in place, accounted for by Trash. */
export function commitReplacement(
  database: DatabaseSync,
  target: ReplacementTarget,
  next: {
    revisionId: string;
    format: BookFormat;
    title: string | null;
    authors: string[];
    subjects: string[];
    coverPath: string | null;
  },
  at: number,
): string {
  const book = checkReplacementTarget(database, target);
  const title =
    !book.title_manual && next.title ? next.title : String(book.title);
  database
    .prepare(`UPDATE books SET current_revision_id = ?, title = ?,
    cover_path = CASE WHEN cover_manual = 0 THEN coalesce(?, cover_path) ELSE cover_path END,
    session_generation = session_generation + 1, updated_at = ? WHERE id = ?`)
    .run(next.revisionId, title, next.coverPath, at, target.bookId);
  if (!book.authors_manual && next.authors.length) {
    database
      .prepare("DELETE FROM book_authors WHERE book_id = ?")
      .run(target.bookId);
    const insert = database.prepare(
      "INSERT INTO book_authors (book_id, position, name) VALUES (?, ?, ?)",
    );
    next.authors.forEach((name, index) => {
      insert.run(target.bookId, index, name);
    });
  }
  if (!book.subjects_manual && next.subjects.length) {
    database
      .prepare("DELETE FROM book_subjects WHERE book_id = ?")
      .run(target.bookId);
    const insert = database.prepare(
      "INSERT INTO book_subjects (book_id, label, label_key) VALUES (?, ?, ?)",
    );
    for (const label of next.subjects)
      insert.run(target.bookId, label, foldKey(label));
  }
  // Zoom applies to PDFs and fixed EPUBs. Font size applies only to EPUBs;
  // a cross-format switch drops it. The adapter uses only applicable sizing.
  if (book.format !== next.format)
    database
      .prepare(
        "UPDATE reader_settings SET font_size = NULL, updated_at = ? WHERE book_id = ?",
      )
      .run(at, target.bookId);
  database
    .prepare("UPDATE revisions SET retired_at = ? WHERE id = ?")
    .run(at, target.revisionId);
  database
    .prepare(`INSERT INTO trash_entries (id, kind, book_id, revision_id, trashed_at)
    VALUES (?, 'revision', ?, ?, ?)`)
    .run(randomUUID(), target.bookId, target.revisionId, at);
  return title;
}
