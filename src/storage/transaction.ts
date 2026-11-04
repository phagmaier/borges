import type { DatabaseSync } from "node:sqlite";

/**
 * Run `work` in a `BEGIN IMMEDIATE` transaction: commit its result or roll
 * back and rethrow. Not reentrant; callers own one transaction at a time.
 */
export function immediate<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled back (for example on SQLITE_FULL).
    }
    throw error;
  }
}
