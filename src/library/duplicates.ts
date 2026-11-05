import type { DatabaseSync } from "node:sqlite";
import type { ExistingBook } from "./import.ts";
import { foldKey } from "./rules.ts";

export interface DuplicateCandidate extends ExistingBook {
  revisionId: string;
  authors: string[];
  format: string;
  fileName: string;
}
export interface DuplicatePrompt {
  name: string;
  title: string;
  authors: string[];
  candidates: DuplicateCandidate[];
}
export type DuplicateChoice =
  | { action: "keep-both" | "skip" }
  | { action: "replace"; bookId: string };

/** Metadata suggests identity only when extracted title and an author agree.
 * Compare effective live metadata, including archived books, without paths. */
export function metadataDuplicates(
  database: DatabaseSync,
  title: string | null,
  authors: string[],
): DuplicateCandidate[] {
  const key = foldKey(title ?? "");
  const authorKeys = new Set(authors.map(foldKey).filter(Boolean));
  if (!key || !authorKeys.size) return [];
  return database
    .prepare(`SELECT b.id, b.title, b.archived_at,
    r.id AS revision_id, r.format, r.original_filename FROM books b
    JOIN revisions r ON r.id = b.current_revision_id
    WHERE b.deleted_at IS NULL ORDER BY b.created_at, b.id`)
    .all()
    .filter((row) => foldKey(String(row.title)) === key)
    .flatMap((row) => {
      const names = database
        .prepare(
          "SELECT name FROM book_authors WHERE book_id = ? ORDER BY position",
        )
        .all(row.id as string)
        .map((author) => String(author.name));
      if (!names.some((name) => authorKeys.has(foldKey(name)))) return [];
      return [
        {
          bookId: String(row.id),
          title: String(row.title),
          archived: row.archived_at !== null,
          revisionId: String(row.revision_id),
          authors: names,
          format: String(row.format),
          fileName: String(row.original_filename),
        },
      ];
    });
}
