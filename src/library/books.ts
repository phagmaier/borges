import type { DatabaseSync } from "node:sqlite";
import { immediate } from "../storage/transaction.ts";
import { type BookSummary, readBook } from "./query.ts";
import {
  cleanList,
  foldKey,
  LibraryError,
  requireId,
  requireName,
  storage,
} from "./rules.ts";

// Per-book reading status, Archive and manual metadata. Status and Archive
// are independent (see the spec's transition table). None of these close a
// reader; Start Rereading retires the open session so the coordinator must
// flush and stop it first, then restart the reader at the beginning.

export interface MetadataEdit {
  title?: string;
  /** Ordered; blank names are dropped. An empty list clears the field. */
  authors?: string[];
  /** A set; repeated labels (ignoring case) keep their first spelling. */
  subjects?: string[];
}

/**
 * Apply manual metadata corrections. Each edited field is marked manual so
 * later extraction cannot overwrite it, including an intentional clear.
 */
export function editMetadata(
  database: DatabaseSync,
  bookId: unknown,
  input: unknown,
  now: number = Date.now(),
): BookSummary {
  const id = requireId(bookId, "book");
  const edit = parseMetadataEdit(input);
  return storage(
    () =>
      immediate(database, () => {
        requireLiveBook(database, id);
        if (edit.title !== undefined)
          database
            .prepare(
              "UPDATE books SET title = ?, title_manual = 1, updated_at = ? WHERE id = ?",
            )
            .run(edit.title, now, id);
        if (edit.authors !== undefined) {
          database
            .prepare("DELETE FROM book_authors WHERE book_id = ?")
            .run(id);
          const insert = database.prepare(
            "INSERT INTO book_authors (book_id, position, name) VALUES (?, ?, ?)",
          );
          edit.authors.forEach((name, position) => {
            insert.run(id, position, name);
          });
          database
            .prepare(
              "UPDATE books SET authors_manual = 1, updated_at = ? WHERE id = ?",
            )
            .run(now, id);
        }
        if (edit.subjects !== undefined) {
          database
            .prepare("DELETE FROM book_subjects WHERE book_id = ?")
            .run(id);
          const insert = database.prepare(
            "INSERT INTO book_subjects (book_id, label, label_key) VALUES (?, ?, ?)",
          );
          for (const label of edit.subjects)
            insert.run(id, label, foldKey(label));
          database
            .prepare(
              "UPDATE books SET subjects_manual = 1, updated_at = ? WHERE id = ?",
            )
            .run(now, id);
        }
        return readBook(database, id);
      }),
    "write",
  );
}

export function parseMetadataEdit(input: unknown): MetadataEdit {
  const value = (input ?? {}) as Record<string, unknown>;
  const edit: MetadataEdit = {};
  if (value.title !== undefined) edit.title = requireName(value.title, "Title");
  if (value.authors !== undefined)
    edit.authors = cleanList(value.authors, "Authors");
  if (value.subjects !== undefined) {
    const seen = new Set<string>();
    edit.subjects = cleanList(value.subjects, "Subjects").filter((label) => {
      const key = foldKey(label);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return edit;
}

/**
 * Record a successful open (call only after the reader rendered the book;
 * a failed load changes nothing). An unread book that is not archived
 * becomes Currently Reading; finished or archived books are being consulted
 * for reference and keep their status.
 */
export function recordSuccessfulOpen(
  database: DatabaseSync,
  bookId: unknown,
  now: number = Date.now(),
): BookSummary {
  return update(
    database,
    bookId,
    `UPDATE books SET last_opened_at = :now,
       updated_at = CASE WHEN reading_status = 'unread' AND archived_at IS NULL
         THEN :now ELSE updated_at END,
       reading_status = CASE WHEN reading_status = 'unread' AND archived_at IS NULL
         THEN 'reading' ELSE reading_status END
     WHERE id = :id`,
    now,
  );
}

/** Explicit Finish; keeps the position and the Archive flag. */
export function markFinished(
  database: DatabaseSync,
  bookId: unknown,
  now: number = Date.now(),
): BookSummary {
  return update(
    database,
    bookId,
    "UPDATE books SET reading_status = 'finished', updated_at = :now WHERE id = :id",
    now,
  );
}

/** Archive any book; status, position and sections are kept. */
export function archiveBook(
  database: DatabaseSync,
  bookId: unknown,
  now: number = Date.now(),
): BookSummary {
  return update(
    database,
    bookId,
    `UPDATE books SET archived_at = :now, updated_at = :now
     WHERE id = :id AND archived_at IS NULL`,
    now,
  );
}

export function unarchiveBook(
  database: DatabaseSync,
  bookId: unknown,
  now: number = Date.now(),
): BookSummary {
  return update(
    database,
    bookId,
    `UPDATE books SET archived_at = NULL, updated_at = :now
     WHERE id = :id AND archived_at IS NOT NULL`,
    now,
  );
}

/**
 * Currently Reading, unarchived, and back at the beginning of the current
 * revision. Advances the session generation in the same commit, so a reader
 * session that was open before cannot write its old position back.
 */
export function startRereading(
  database: DatabaseSync,
  bookId: unknown,
  now: number = Date.now(),
): BookSummary {
  const id = requireId(bookId, "book");
  return storage(
    () =>
      immediate(database, () => {
        requireLiveBook(database, id);
        database
          .prepare(
            `UPDATE books SET reading_status = 'reading', archived_at = NULL,
               session_generation = session_generation + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, id);
        database
          .prepare(
            "DELETE FROM positions WHERE revision_id = (SELECT current_revision_id FROM books WHERE id = ?)",
          )
          .run(id);
        return readBook(database, id);
      }),
    "write",
  );
}

function update(
  database: DatabaseSync,
  bookId: unknown,
  sql: string,
  now: number,
): BookSummary {
  const id = requireId(bookId, "book");
  return storage(
    () =>
      immediate(database, () => {
        requireLiveBook(database, id);
        database.prepare(sql).run({ id, now });
        return readBook(database, id);
      }),
    "write",
  );
}

function requireLiveBook(database: DatabaseSync, id: string): void {
  const row = database
    .prepare("SELECT 1 FROM books WHERE id = ? AND deleted_at IS NULL")
    .get(id);
  if (!row)
    throw new LibraryError("unknown-book", "This book is not in the library.");
}
