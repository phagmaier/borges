import { readdir } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { digestFile, entryKind, removeFile } from "../storage/files.ts";
import { resolveLibraryPath } from "../storage/paths.ts";
import { immediate } from "../storage/transaction.ts";

// Startup reconciliation for the file/catalog operation protocol. SQLite
// commits do not cover filesystem changes, so every import is recorded before
// bytes move and each step's state is committed after it becomes durable:
//
//   pending    staged_path may hold a partial copy; nothing is published
//   staged     the complete copy's digest is recorded; bytes are at
//              staged_path or, after an interrupted rename, at published_path
//   published  bytes are at published_path; catalog commit not yet done
//   committed  catalog references point to published bytes (same commit)
//   abandoned  rolled back; no artifacts of this operation remain
//   failed     uncertain artifacts were retained for repair; never touched
//
// A rollback whose file removal fails leaves the state unchanged for retry.
//
// An import that did not reach its catalog commit is rolled back: its copy is
// removed and the untouched source can be imported again. Only paths named by
// the record whose content matches the recorded digest are removed; anything
// unexpected is retained and reported.

export interface LibraryHandle {
  readonly root: string;
  readonly database: DatabaseSync;
}

export type OperationState =
  | "pending"
  | "staged"
  | "published"
  | "committed"
  | "failed"
  | "abandoned";

export interface OperationRecord {
  id: string;
  kind: string;
  state: OperationState;
  bookId: string | null;
  revisionId: string | null;
  stagedPath: string | null;
  publishedPath: string | null;
  detail: OperationDetail;
}

export interface OperationDetail {
  sourceName?: string;
  format?: string;
  sha256?: string;
  size?: number;
  title?: string;
  /** Why the operation was rolled back or retained. */
  reason?: string;
  [key: string]: unknown;
}

export interface ReconciledOperation {
  operationId: string;
  kind: string;
  previousState: OperationState;
  outcome: "rolled-back" | "retained";
  /** Root-relative paths removed by this reconciliation. */
  removed: string[];
  /** Root-relative paths deliberately left in place. */
  retained: string[];
  message: string;
}

export interface ReconciliationReport {
  operations: ReconciledOperation[];
  /** Managed-directory entries no record or revision accounts for; kept. */
  unrecognized: string[];
}

export function readOperation(
  database: DatabaseSync,
  id: string,
): OperationRecord | null {
  const row = database
    .prepare("SELECT * FROM recovery_operations WHERE id = ?")
    .get(id);
  return row ? toRecord(row) : null;
}

function toRecord(row: Record<string, unknown>): OperationRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    state: row.state as OperationState,
    bookId: (row.book_id as string | null) ?? null,
    revisionId: (row.revision_id as string | null) ?? null,
    stagedPath: (row.staged_path as string | null) ?? null,
    publishedPath: (row.published_path as string | null) ?? null,
    detail: JSON.parse(String(row.detail)) as OperationDetail,
  };
}

/** Commit a state change; the caller has made the step it records durable. */
export function setOperationState(
  database: DatabaseSync,
  id: string,
  state: OperationState,
  changes: { publishedPath?: string; detail?: OperationDetail } = {},
  now: number = Date.now(),
): void {
  database
    .prepare(
      `UPDATE recovery_operations SET state = ?,
         published_path = coalesce(?, published_path),
         detail = json_patch(detail, ?), updated_at = ?
       WHERE id = ?`,
    )
    .run(
      state,
      changes.publishedPath ?? null,
      JSON.stringify(changes.detail ?? {}),
      now,
      id,
    );
}

/**
 * Reconcile every interrupted operation. Run once at startup, after the root
 * lock is held and before any new operation starts.
 */
export async function reconcileOperations(
  library: LibraryHandle,
  now: () => number = Date.now,
): Promise<ReconciliationReport> {
  const { database } = library;
  const open = database
    .prepare(
      "SELECT * FROM recovery_operations WHERE state NOT IN ('committed', 'abandoned') ORDER BY created_at, id",
    )
    .all()
    .map(toRecord);
  const operations: ReconciledOperation[] = [];
  for (const record of open) {
    operations.push(
      record.state === "failed"
        ? retainedAgain(record)
        : await rollBackOperation(
            library,
            record,
            "interrupted before its catalog commit",
            now,
          ),
    );
  }
  return { operations, unrecognized: await unrecognizedEntries(library) };
}

function retainedAgain(record: OperationRecord): ReconciledOperation {
  return {
    operationId: record.id,
    kind: record.kind,
    previousState: record.state,
    outcome: "retained",
    removed: [],
    retained: Array.isArray(record.detail.retained)
      ? record.detail.retained.map(String)
      : [],
    message: `Operation ${record.id} still needs repair: ${record.detail.reason ?? "unknown cause"}.`,
  };
}

/**
 * Undo an uncommitted operation: remove the files it provably created, then
 * mark it abandoned. Anything that cannot be verified is retained and the
 * operation is marked failed instead. Also used for in-process failures, so a
 * failed import and a crashed one end in the same state.
 */
export async function rollBackOperation(
  library: LibraryHandle,
  record: OperationRecord,
  reason: string,
  now: () => number = Date.now,
): Promise<ReconciledOperation> {
  const { root, database } = library;
  const base = {
    operationId: record.id,
    kind: record.kind,
    previousState: record.state,
  };
  const retain = (problem: string, retained: string[], removed: string[]) => {
    const message = `${operationLabel(record)} was ${reason}; ${problem}. Its files were kept for repair.`;
    immediate(database, () =>
      setOperationState(
        database,
        record.id,
        "failed",
        { detail: { reason: message, retained } },
        now(),
      ),
    );
    return {
      ...base,
      outcome: "retained" as const,
      removed,
      retained,
      message,
    };
  };

  const candidates = [record.stagedPath, record.publishedPath].filter(
    (path): path is string => path !== null,
  );
  if (record.kind !== "import" && record.kind !== "cover") {
    return retain(
      `this build cannot reconcile ${record.kind} operations`,
      candidates,
      [],
    );
  }
  if (
    record.kind === "cover" &&
    (record.stagedPath !== `staging/${record.id}.partial` ||
      (record.publishedPath !== null &&
        record.publishedPath !== `covers/${record.id}.png`))
  )
    return retain(
      "its paths do not belong to this cover operation",
      candidates,
      [],
    );
  if (referencedByCatalog(database, record)) {
    return retain("the catalog already references its bytes", candidates, []);
  }
  const present: string[] = [];
  for (const path of candidates) {
    const kind = await entryKind(resolveLibraryPath(root, path));
    if (kind === "other")
      return retain(`${path} is not a regular file`, candidates, []);
    if (kind === "file") present.push(path);
  }
  // A complete copy is identified by its recorded digest. Before that is
  // recorded (pending) the only candidate is this operation's own partial
  // staging file, which is never published.
  if (record.state !== "pending") {
    if (present.length > 1)
      return retain("its bytes exist at both paths", present, []);
    for (const path of present) {
      const digest = await digestFile(resolveLibraryPath(root, path));
      if (
        digest.sha256 !== record.detail.sha256 ||
        digest.size !== record.detail.size
      ) {
        return retain(`${path} does not match the recorded copy`, present, []);
      }
    }
  } else if (present.some((path) => path !== record.stagedPath)) {
    return retain("an unexpected published file exists", present, []);
  }
  const removed: string[] = [];
  for (const path of present) {
    try {
      await removeFile(resolveLibraryPath(root, path));
    } catch (error) {
      // Not uncertainty, just a failed removal: keep the record open so the
      // next startup retries the same verified rollback.
      return {
        ...base,
        outcome: "retained",
        removed,
        retained: present.filter((entry) => !removed.includes(entry)),
        message: `${operationLabel(record)} was ${reason}; ${path} could not be removed (${message(error)}). The rollback will be retried at the next start.`,
      };
    }
    removed.push(path);
  }
  const text = `${operationLabel(record)} was ${reason} and has been rolled back${
    removed.length ? ` (removed ${removed.join(", ")})` : ""
  }. The source file was not changed; ${record.kind === "cover" ? "choose the cover again" : "import it again"} if needed.`;
  immediate(database, () =>
    setOperationState(
      database,
      record.id,
      "abandoned",
      { detail: { reason: text } },
      now(),
    ),
  );
  return {
    ...base,
    outcome: "rolled-back",
    removed,
    retained: [],
    message: text,
  };
}

function referencedByCatalog(
  database: DatabaseSync,
  record: OperationRecord,
): boolean {
  if (record.kind === "cover") {
    return Boolean(
      database
        .prepare(`SELECT 1 FROM books WHERE cover_path IN (?, ?)
      UNION ALL SELECT 1 FROM revisions WHERE extracted_cover_path IN (?, ?) LIMIT 1`)
        .get(
          record.stagedPath,
          record.publishedPath,
          record.stagedPath,
          record.publishedPath,
        ),
    );
  }
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM revisions WHERE id = ? OR path = ? OR book_id = ? UNION ALL SELECT 1 FROM books WHERE id = ? LIMIT 1",
      )
      .get(
        record.revisionId,
        record.publishedPath,
        record.bookId,
        record.bookId,
      ),
  );
}

/** Report, never delete: a filename alone does not prove cleanup is safe. */
async function unrecognizedEntries(library: LibraryHandle): Promise<string[]> {
  const { root, database } = library;
  const known = new Set<string>();
  for (const row of database
    .prepare(
      `SELECT path FROM revisions
       UNION SELECT cover_path FROM books
       UNION SELECT extracted_cover_path FROM revisions
       UNION SELECT published_path FROM recovery_operations WHERE kind = 'cover' AND state = 'committed'
       UNION SELECT staged_path FROM recovery_operations
         WHERE state NOT IN ('committed', 'abandoned')
       UNION SELECT published_path FROM recovery_operations
         WHERE state NOT IN ('committed', 'abandoned')`,
    )
    .all()) {
    if (row.path !== null) known.add(String(row.path));
  }
  const found: string[] = [];
  for (const directory of ["staging", "files", "covers"]) {
    const entries = await readdir(resolveLibraryPath(root, directory));
    for (const entry of entries.sort()) {
      const path = `${directory}/${entry}`;
      if (!known.has(path)) found.push(path);
    }
  }
  return found;
}

function operationLabel(record: OperationRecord): string {
  const source = record.detail.sourceName;
  return `The ${record.kind} operation ${record.id}${source ? ` for ${source}` : ""}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
