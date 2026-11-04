import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOCK_FILE, LOCK_OWNER_FILE } from "./paths.ts";

/** Diagnostic description of a lock holder. Never used to grant ownership. */
export interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  executable: string;
  acquiredAt: number;
}

export class LibraryLockedError extends Error {
  readonly root: string;
  readonly owner: LockOwner | null;
  constructor(root: string, owner: LockOwner | null) {
    super(
      `The library at ${root} is in use by another Borges process${
        owner ? ` (process ${owner.pid} on ${owner.hostname})` : ""
      }. Close that copy of Borges, then start again.`,
    );
    this.name = "LibraryLockedError";
    this.root = root;
    this.owner = owner;
  }
}

export interface RootLock {
  readonly owner: LockOwner;
  /** Owner record left by a holder that no longer holds the kernel lock. */
  readonly recoveredStale: LockOwner | null;
  release(): void;
}

/**
 * Exclusive library-root lock. Ownership is an SQLite `EXCLUSIVE` file lock
 * (POSIX advisory lock) held by one connection for the process lifetime. The
 * kernel drops it when the holder exits or is killed, so acquiring it is the
 * verification that no live process owns the root; no PID guessing or
 * lock-file deletion is involved. The JSON owner file only explains conflicts.
 *
 * Do not open or close the lock file with `node:fs` in the holding process:
 * closing any descriptor to it releases POSIX locks held by that process.
 */
export function acquireRootLock(root: string): RootLock {
  const database = new DatabaseSync(join(root, LOCK_FILE), { timeout: 0 });
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    executable: process.execPath,
    acquiredAt: Date.now(),
  };
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    // The first write in EXCLUSIVE locking mode takes a lock that is kept
    // until the connection closes.
    database.exec(`BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS holder (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        acquired_at INTEGER NOT NULL
      ) STRICT;`);
    database
      .prepare("INSERT OR REPLACE INTO holder VALUES (1, ?, ?)")
      .run(owner.token, owner.acquiredAt);
    database.exec("COMMIT");
  } catch (error) {
    database.close();
    if (isBusy(error)) throw new LibraryLockedError(root, readOwner(root));
    throw new Error(
      `The library lock at ${join(root, LOCK_FILE)} cannot be used: ${String(
        error instanceof Error ? error.message : error,
      )}. If no Borges process is running, move that file aside and start again.`,
    );
  }
  const recoveredStale = readOwner(root);
  try {
    writeOwner(root, owner);
  } catch (error) {
    database.close();
    throw error;
  }
  let released = false;
  return {
    owner,
    recoveredStale,
    release() {
      if (released) return;
      released = true;
      try {
        if (readOwner(root)?.token === owner.token)
          rmSync(join(root, LOCK_OWNER_FILE), { force: true });
      } finally {
        database.close();
      }
    },
  };
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  // SQLITE_BUSY / SQLITE_LOCKED, including extended result codes.
  return typeof code === "number" && [5, 6].includes(code & 0xff);
}

function readOwner(root: string): LockOwner | null {
  try {
    const value = JSON.parse(
      readFileSync(join(root, LOCK_OWNER_FILE), "utf8"),
    ) as Partial<LockOwner>;
    return typeof value.token === "string" &&
      Number.isInteger(value.pid) &&
      typeof value.hostname === "string"
      ? (value as LockOwner)
      : null;
  } catch {
    return null;
  }
}

function writeOwner(root: string, owner: LockOwner): void {
  const target = join(root, LOCK_OWNER_FILE);
  const temporary = `${target}.${owner.token}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
