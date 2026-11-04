import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { immediate } from "../storage/transaction.ts";
import {
  foldKey,
  LibraryError,
  requireId,
  requireIds,
  requireName,
  storage,
} from "./rules.ts";

// Nested sections and overlapping memberships. Sections are logical groups:
// nothing here copies, moves or deletes book files, and removing a section or
// membership never deletes a book. The schema enforces the same sibling-name,
// cycle and cascade rules; these checks turn them into explanations.

export interface SectionDeletion {
  /** The section and all of its descendants. */
  sections: number;
  /** Live books with a membership somewhere in the branch. */
  books: number;
  /** Of those, books with no membership outside the branch (become Unfiled). */
  unfiled: number;
}

export function createSection(
  database: DatabaseSync,
  input: { name: unknown; parentId?: unknown },
  now: number = Date.now(),
): { id: string; name: string } {
  const name = requireName(input.name, "A section name");
  const parentId =
    input.parentId === undefined || input.parentId === null
      ? null
      : requireId(input.parentId, "parent section");
  return storage(
    () =>
      immediate(database, () => {
        if (parentId !== null) requireSection(database, parentId);
        requireUniqueName(database, parentId, name, null);
        const id = randomUUID();
        database
          .prepare(
            "INSERT INTO sections (id, parent_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, parentId, name, foldKey(name), now);
        return { id, name };
      }),
    "write",
  );
}

export function renameSection(
  database: DatabaseSync,
  sectionId: unknown,
  newName: unknown,
): { id: string; name: string } {
  const id = requireId(sectionId, "section");
  const name = requireName(newName, "A section name");
  return storage(
    () =>
      immediate(database, () => {
        const section = requireSection(database, id);
        requireUniqueName(database, section.parentId, name, id);
        database
          .prepare("UPDATE sections SET name = ?, name_key = ? WHERE id = ?")
          .run(name, foldKey(name), id);
        return { id, name };
      }),
    "write",
  );
}

/** Move a section (with its branch) under another section, or to the root. */
export function moveSection(
  database: DatabaseSync,
  sectionId: unknown,
  newParentId: unknown,
): void {
  const id = requireId(sectionId, "section");
  const parentId =
    newParentId === null ? null : requireId(newParentId, "parent section");
  storage(
    () =>
      immediate(database, () => {
        const section = requireSection(database, id);
        if (parentId !== null) {
          requireSection(database, parentId);
          if (branchIds(database, id).includes(parentId))
            throw new LibraryError(
              "section-cycle",
              "A section cannot be moved inside itself or one of its subsections.",
            );
        }
        requireUniqueName(database, parentId, section.name, id);
        database
          .prepare("UPDATE sections SET parent_id = ? WHERE id = ?")
          .run(parentId, id);
      }),
    "write",
  );
}

/** What deleting a section would remove, for the confirmation prompt. */
export function previewSectionDeletion(
  database: DatabaseSync,
  sectionId: unknown,
): SectionDeletion {
  const id = requireId(sectionId, "section");
  return storage(() => {
    requireSection(database, id);
    return countDeletion(database, id);
  }, "read");
}

/**
 * Delete a section, its descendants and their memberships. Books, their
 * files and memberships elsewhere are kept. Call only after confirmation.
 */
export function deleteSection(
  database: DatabaseSync,
  sectionId: unknown,
): SectionDeletion {
  const id = requireId(sectionId, "section");
  return storage(
    () =>
      immediate(database, () => {
        requireSection(database, id);
        const deletion = countDeletion(database, id);
        // ON DELETE CASCADE removes the descendants and their memberships.
        database.prepare("DELETE FROM sections WHERE id = ?").run(id);
        return deletion;
      }),
    "write",
  );
}

/** Add books to a section, keeping their other memberships. */
export function addBooksToSection(
  database: DatabaseSync,
  sectionId: unknown,
  bookIds: unknown,
  now: number = Date.now(),
): { added: number } {
  const id = requireId(sectionId, "section");
  const books = requireIds(bookIds, "book");
  return storage(
    () =>
      immediate(database, () => {
        requireSection(database, id);
        requireLiveBooks(database, books);
        const insert = database.prepare(
          "INSERT OR IGNORE INTO section_memberships (section_id, book_id, added_at) VALUES (?, ?, ?)",
        );
        let added = 0;
        for (const book of books)
          added += Number(insert.run(id, book, now).changes);
        return { added };
      }),
    "write",
  );
}

/** Remove books' direct membership in one section; the books remain. */
export function removeBooksFromSection(
  database: DatabaseSync,
  sectionId: unknown,
  bookIds: unknown,
): { removed: number } {
  const id = requireId(sectionId, "section");
  const books = requireIds(bookIds, "book");
  return storage(
    () =>
      immediate(database, () => {
        requireSection(database, id);
        const remove = database.prepare(
          "DELETE FROM section_memberships WHERE section_id = ? AND book_id = ?",
        );
        let removed = 0;
        for (const book of books)
          removed += Number(remove.run(id, book).changes);
        return { removed };
      }),
    "write",
  );
}

function requireSection(
  database: DatabaseSync,
  id: string,
): { name: string; parentId: string | null } {
  const row = database
    .prepare("SELECT name, parent_id FROM sections WHERE id = ?")
    .get(id);
  if (!row)
    throw new LibraryError("unknown-section", "This section no longer exists.");
  return { name: String(row.name), parentId: row.parent_id as string | null };
}

function requireUniqueName(
  database: DatabaseSync,
  parentId: string | null,
  name: string,
  self: string | null,
): void {
  const clash = database
    .prepare(
      `SELECT name FROM sections
       WHERE coalesce(parent_id, '') = coalesce(?, '') AND name_key = ?
         AND id IS NOT ?`,
    )
    .get(parentId, foldKey(name), self);
  if (clash)
    throw new LibraryError(
      "name-conflict",
      `${parentId === null ? "Another top-level section" : "Another section here"} is already named “${String(clash.name)}”.`,
    );
}

function requireLiveBooks(database: DatabaseSync, ids: string[]): void {
  const live = database.prepare(
    "SELECT 1 FROM books WHERE id = ? AND deleted_at IS NULL",
  );
  for (const id of ids)
    if (!live.get(id))
      throw new LibraryError(
        "unknown-book",
        "One of the selected books is no longer in the library.",
      );
}

const BRANCH = `WITH RECURSIVE branch(id) AS (
  SELECT ? UNION SELECT sections.id FROM sections
    JOIN branch ON sections.parent_id = branch.id)`;

function branchIds(database: DatabaseSync, id: string): string[] {
  return database
    .prepare(`${BRANCH} SELECT id FROM branch`)
    .all(id)
    .map((row) => String(row.id));
}

function countDeletion(database: DatabaseSync, id: string): SectionDeletion {
  const row = database
    .prepare(
      `${BRANCH}, affected(book_id) AS (
         SELECT DISTINCT m.book_id FROM section_memberships m
           JOIN branch ON m.section_id = branch.id
           JOIN books b ON b.id = m.book_id AND b.deleted_at IS NULL)
       SELECT
         (SELECT count(*) FROM branch) AS sections,
         (SELECT count(*) FROM affected) AS books,
         (SELECT count(*) FROM affected a WHERE NOT EXISTS (
            SELECT 1 FROM section_memberships m
            WHERE m.book_id = a.book_id
              AND m.section_id NOT IN (SELECT id FROM branch))) AS unfiled`,
    )
    .get(id);
  return {
    sections: Number(row?.sections),
    books: Number(row?.books),
    unfiled: Number(row?.unfiled),
  };
}
