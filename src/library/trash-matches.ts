import type { DatabaseSync } from "node:sqlite";
import type { FileDigest } from "../storage/files.ts";
export interface TrashCandidate {
  entryId: string;
  kind: "book" | "revision";
  bookId: string;
  revisionId: string;
  currentRevisionId: string;
  ownerDeleted: boolean;
  title: string;
  fileName: string;
  format: "pdf" | "epub";
}
export interface TrashMatchPrompt {
  name: string;
  candidates: TrashCandidate[];
}
export type TrashRestoreMode = "book" | "current" | "separate";
export type TrashChoice =
  | { action: "cancel" }
  | { action: "restore"; entryId: string; mode: TrashRestoreMode };
export interface RestoredImportInfo {
  bookId: string;
  title: string;
  warnings: string[];
}
export function trashCandidates(
  database: DatabaseSync,
  digest?: FileDigest,
): TrashCandidate[] {
  return database
    .prepare(`SELECT t.id, t.kind, b.id AS book_id, b.title, b.deleted_at, b.current_revision_id,
    r.id AS revision_id, r.original_filename, r.format FROM trash_entries t JOIN books b ON b.id = t.book_id
    JOIN revisions r ON r.id = coalesce(t.revision_id, b.current_revision_id)
    WHERE (? IS NULL OR (r.sha256 = ? AND r.size = ?)) ORDER BY t.trashed_at, t.id`)
    .all(digest?.sha256 ?? null, digest?.sha256 ?? null, digest?.size ?? null)
    .map((row) => ({
      entryId: String(row.id),
      kind: row.kind as "book" | "revision",
      bookId: String(row.book_id),
      revisionId: String(row.revision_id),
      currentRevisionId: String(row.current_revision_id),
      ownerDeleted: row.deleted_at !== null,
      title: String(row.title),
      fileName: String(row.original_filename),
      format: row.format as "pdf" | "epub",
    }));
}
