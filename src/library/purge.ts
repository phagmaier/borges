import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  digestFile,
  entryKind,
  removeFile,
  syncDirectory,
} from "../storage/files.ts";
import { resolveLibraryPath } from "../storage/paths.ts";
import { immediate } from "../storage/transaction.ts";
import type { LibraryHandle, ReconciledOperation } from "./recovery.ts";
import { LibraryError } from "./rules.ts";

interface PurgeFile {
  path: string;
  sha256: string;
  size: number;
  revisionId?: string;
}
interface PurgePlan {
  version: 1;
  bookId: string;
  deleteBook: boolean;
  entryIds: string[];
  revisions: PurgeFile[];
  covers: PurgeFile[];
}
export interface PurgeResult {
  purged: number;
  failures: { title: string; message: string }[];
}
export type PurgeCheckpoint = (
  step: "recorded" | "removed" | "files-removed" | "committing" | "committed",
) => void;

/** Restoration cannot resurrect bytes after an explicitly confirmed purge starts. */
export function assertNotPurging(database: DatabaseSync, bookId: string): void {
  if (
    database
      .prepare(
        "SELECT 1 FROM recovery_operations WHERE kind = 'purge' AND book_id = ? AND state <> 'committed' AND state <> 'abandoned'",
      )
      .get(bookId)
  )
    throw new LibraryError(
      "invalid",
      "A confirmed purge for this book is unfinished. Retry Empty Trash to finish it; its files can no longer be restored.",
    );
}

function planFor(database: DatabaseSync, entryId: string): PurgePlan {
  const entry = database
    .prepare(
      `SELECT t.*, b.deleted_at FROM trash_entries t JOIN books b ON b.id = t.book_id WHERE t.id = ?`,
    )
    .get(entryId);
  if (!entry) throw new Error("This entry is no longer in Trash.");
  const bookId = String(entry.book_id);
  const deleted = entry.deleted_at !== null;
  const entries = database
    .prepare("SELECT * FROM trash_entries WHERE book_id = ?")
    .all(bookId);
  if (deleted && !entries.some((e) => e.kind === "book"))
    throw new Error(
      "The deleted book has no Trash record; its bytes were kept for repair.",
    );
  const revisions = database
    .prepare(
      deleted
        ? "SELECT * FROM revisions WHERE book_id = ?"
        : "SELECT * FROM revisions WHERE id = ? AND book_id = ?",
    )
    .all(...(deleted ? [bookId] : [String(entry.revision_id), bookId]));
  const ids = deleted ? entries.map((e) => String(e.id)) : [entryId];
  const covers = new Set<string>();
  if (deleted) {
    const book = database
      .prepare("SELECT cover_path FROM books WHERE id = ?")
      .get(bookId);
    if (book?.cover_path) covers.add(String(book.cover_path));
    // Accounted-for superseded manual covers are also eligible at explicit purge.
    for (const row of database
      .prepare(
        "SELECT published_path FROM recovery_operations WHERE kind = 'cover' AND state = 'committed' AND book_id = ?",
      )
      .all(bookId))
      if (row.published_path) covers.add(String(row.published_path));
  }
  const files = revisions.map((row) => {
    if (row.path !== `files/${row.id}.${row.format}`)
      throw new Error(
        "The revision path is not owned by its catalog record; bytes were kept for repair.",
      );
    if (row.extracted_cover_path) covers.add(String(row.extracted_cover_path));
    return {
      revisionId: String(row.id),
      path: String(row.path),
      sha256: String(row.sha256),
      size: Number(row.size),
    };
  });
  return {
    version: 1,
    bookId,
    deleteBook: deleted,
    entryIds: ids,
    revisions: files,
    covers: [...covers].map((path) => {
      const row = database
        .prepare(
          "SELECT id, detail FROM recovery_operations WHERE kind = 'cover' AND state = 'committed' AND published_path = ?",
        )
        .get(path);
      if (!row || path !== `covers/${row.id}.png`)
        throw new Error(
          `Cover ${path} has no verified publication record; it was kept for repair.`,
        );
      const detail = JSON.parse(String(row.detail));
      if (!validDigest(detail))
        throw new Error(`Cover ${path} has no recorded digest.`);
      return { path, sha256: detail.sha256, size: detail.size };
    }),
  };
}

function validDigest(value: {
  sha256?: unknown;
  size?: unknown;
}): value is { sha256: string; size: number } {
  return (
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}
function readPlan(database: DatabaseSync, id: string): PurgePlan {
  const row = database
    .prepare(
      "SELECT * FROM recovery_operations WHERE id = ? AND kind = 'purge' AND state = 'pending'",
    )
    .get(id);
  if (!row) throw new Error("The purge operation is no longer pending.");
  const plan = JSON.parse(String(row.detail)) as PurgePlan;
  if (
    plan.version !== 1 ||
    plan.bookId !== row.book_id ||
    typeof plan.deleteBook !== "boolean" ||
    !Array.isArray(plan.entryIds) ||
    !plan.entryIds.length ||
    plan.entryIds.some((x) => typeof x !== "string") ||
    !Array.isArray(plan.revisions) ||
    !plan.revisions.length ||
    !Array.isArray(plan.covers)
  )
    throw new Error("The purge record is damaged; bytes were kept for repair.");
  // Re-derive eligibility from the catalog on EVERY retry, never from a path alone.
  const current = planFor(database, plan.entryIds[0] as string);
  const canonical = (p: PurgePlan) =>
    JSON.stringify({
      version: p.version,
      bookId: p.bookId,
      deleteBook: p.deleteBook,
      entryIds: [...p.entryIds].sort(),
      revisions: [...p.revisions].sort((a, b) => a.path.localeCompare(b.path)),
      covers: [...p.covers].sort((a, b) => a.path.localeCompare(b.path)),
    });
  if (canonical(current) !== canonical(plan))
    throw new Error(
      "The purge's catalog references changed; bytes were kept for repair.",
    );
  return plan;
}
function coverReferenced(
  database: DatabaseSync,
  plan: PurgePlan,
  path: string,
): boolean {
  const ids = new Set(plan.revisions.map((r) => r.revisionId));
  return (
    database
      .prepare("SELECT id FROM books WHERE cover_path = ?")
      .all(path)
      .some((b) => !plan.deleteBook || b.id !== plan.bookId) ||
    database
      .prepare("SELECT id FROM revisions WHERE extracted_cover_path = ?")
      .all(path)
      .some((r) => !ids.has(String(r.id))) ||
    Boolean(
      database
        .prepare(
          "SELECT 1 FROM recovery_operations WHERE kind <> 'purge' AND state NOT IN ('committed', 'abandoned') AND published_path = ?",
        )
        .get(path),
    )
  );
}
function checkRevisions(database: DatabaseSync, plan: PurgePlan): void {
  for (const file of plan.revisions) {
    const live = database
      .prepare(
        "SELECT 1 FROM books WHERE current_revision_id = ? AND (deleted_at IS NULL OR id <> ?)",
      )
      .get(file.revisionId as string, plan.bookId);
    const trash = database
      .prepare(
        `SELECT 1 FROM trash_entries t JOIN revisions r ON r.book_id = t.book_id WHERE r.id = ? AND (t.revision_id = r.id OR (t.kind = 'book' AND ? = 1))`,
      )
      .get(file.revisionId as string, plan.deleteBook ? 1 : 0);
    if (live || !trash)
      throw new Error(
        "A revision is live or no longer eligible for purge. Its bytes were kept.",
      );
  }
}

async function removeVerified(
  library: LibraryHandle,
  file: PurgeFile,
): Promise<void> {
  const path = resolveLibraryPath(library.root, file.path);
  // Refuse symlinked directories as well as final symlinks, even inside the root.
  const parent = await realpath(dirname(path));
  if (
    parent !==
    join(await realpath(library.root), file.revisionId ? "files" : "covers")
  )
    throw new Error(
      `Unsafe managed directory for ${file.path}; kept for repair.`,
    );
  const kind = await entryKind(path);
  if (kind === "missing") {
    await syncDirectory(parent);
    return;
  }
  if (kind !== "file")
    throw new Error(`${file.path} is not a regular file; kept for repair.`);
  const digest = await digestFile(path);
  if (digest.sha256 !== file.sha256 || digest.size !== file.size)
    throw new Error(
      `${file.path} no longer matches its recorded content; kept for repair.`,
    );
  await removeFile(path);
}

/** Resume a durable, confirmed purge; a missing file now means an interrupted unlink. */
export async function resumePurge(
  library: LibraryHandle,
  id: string,
  checkpoint?: PurgeCheckpoint,
): Promise<ReconciledOperation> {
  const { database } = library;
  const removed: string[] = [];
  try {
    const plan = readPlan(database, id);
    checkRevisions(database, plan);
    for (const file of [...plan.revisions, ...plan.covers]) {
      readPlan(database, id);
      checkRevisions(database, plan);
      if (!file.revisionId && coverReferenced(database, plan, file.path))
        continue;
      await removeVerified(library, file);
      removed.push(file.path);
      checkpoint?.("removed");
    }
    checkpoint?.("files-removed");
    immediate(database, () => {
      readPlan(database, id);
      checkRevisions(database, plan);
      for (const entryId of plan.entryIds)
        database.prepare("DELETE FROM trash_entries WHERE id = ?").run(entryId);
      for (const file of plan.revisions) {
        database
          .prepare("DELETE FROM positions WHERE revision_id = ?")
          .run(file.revisionId as string);
        database
          .prepare("DELETE FROM revisions WHERE id = ?")
          .run(file.revisionId as string);
      }
      if (plan.deleteBook) {
        for (const table of [
          "book_authors",
          "book_subjects",
          "reader_settings",
          "section_memberships",
        ])
          database
            .prepare(`DELETE FROM ${table} WHERE book_id = ?`)
            .run(plan.bookId);
        database
          .prepare("DELETE FROM books WHERE id = ? AND deleted_at IS NOT NULL")
          .run(plan.bookId);
      }
      // Keep publication history, but do not count its intentionally removed
      // cover as a missing retained artifact in a later Trash listing.
      for (const cover of plan.covers)
        if (removed.includes(cover.path))
          database
            .prepare(
              "UPDATE recovery_operations SET detail = json_set(detail, '$.purgedBy', ?), updated_at = ? WHERE kind = 'cover' AND state = 'committed' AND published_path = ?",
            )
            .run(id, Date.now(), cover.path);
      database
        .prepare(
          "UPDATE recovery_operations SET state = 'committed', updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), id);
      checkpoint?.("committing");
    });
    checkpoint?.("committed");
    return {
      operationId: id,
      kind: "purge",
      previousState: "pending",
      outcome: "purged",
      removed,
      retained: [],
      message: `Confirmed purge ${id} completed.`,
    };
  } catch (error) {
    const message = `Empty Trash could not finish: ${error instanceof Error ? error.message : String(error)} Retry Empty Trash after resolving the problem.`;
    database
      .prepare(
        "UPDATE recovery_operations SET detail = json_set(detail, '$.reason', ?), updated_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(message, Date.now(), id);
    return {
      operationId: id,
      kind: "purge",
      previousState: "pending",
      outcome: "retained",
      removed,
      retained: [],
      message,
    };
  }
}

/** Confirmed IDs form a snapshot: never expand a stale confirmation to new Trash. */
export async function emptyTrash(
  library: LibraryHandle,
  options: { expectedEntryIds?: string[]; checkpoint?: PurgeCheckpoint } = {},
): Promise<PurgeResult> {
  const { database } = library;
  const entries = database
    .prepare(
      "SELECT t.id, b.title FROM trash_entries t JOIN books b ON b.id = t.book_id ORDER BY t.id",
    )
    .all();
  if (
    options.expectedEntryIds &&
    JSON.stringify([...options.expectedEntryIds].sort()) !==
      JSON.stringify(entries.map((e) => String(e.id)))
  )
    throw new LibraryError(
      "invalid",
      "Trash changed. Review the updated count and storage before emptying it.",
    );
  const result: PurgeResult = { purged: 0, failures: [] };
  const attempted = new Set<string>();
  for (const entry of entries) {
    if (
      !database
        .prepare("SELECT 1 FROM trash_entries WHERE id = ?")
        .get(String(entry.id))
    )
      continue;
    try {
      const plan = planFor(database, String(entry.id));
      if (attempted.has(plan.bookId) && plan.deleteBook) continue;
      if (plan.deleteBook) attempted.add(plan.bookId);
      const existing = database
        .prepare(
          "SELECT id, detail FROM recovery_operations WHERE kind = 'purge' AND book_id = ? AND state = 'pending'",
        )
        .all(plan.bookId)
        .find((row) => {
          const detail = JSON.parse(String(row.detail));
          return (
            Array.isArray(detail.entryIds) && detail.entryIds.includes(entry.id)
          );
        });
      const id = existing ? String(existing.id) : randomUUID();
      if (!existing)
        immediate(database, () => {
          checkRevisions(database, plan);
          database
            .prepare(
              "INSERT INTO recovery_operations (id, kind, state, book_id, detail, created_at, updated_at) VALUES (?, 'purge', 'pending', ?, ?, ?, ?)",
            )
            .run(id, plan.bookId, JSON.stringify(plan), Date.now(), Date.now());
        });
      options.checkpoint?.("recorded");
      const report = await resumePurge(library, id, options.checkpoint);
      if (report.outcome === "purged") result.purged += plan.entryIds.length;
      else
        result.failures.push({
          title: String(entry.title),
          message: report.message,
        });
    } catch (error) {
      database
        .prepare(
          "UPDATE trash_entries SET context = json_set(context, '$.purgeProblem', ?) WHERE id = ?",
        )
        .run(
          error instanceof Error ? error.message : String(error),
          String(entry.id),
        );
      result.failures.push({
        title: String(entry.title),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
