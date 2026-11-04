import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireRootLock, type LockOwner, type RootLock } from "./lock.ts";
import {
  CATALOG_FILE,
  LIBRARY_DIRECTORIES,
  resolveLibraryPath,
  toLibraryPath,
} from "./paths.ts";
import {
  CATALOG_APPLICATION_ID,
  catalogMigrations,
  type Migration,
} from "./schema.ts";

export type CatalogErrorCode =
  | "newer-schema"
  | "not-a-catalog"
  | "damaged"
  | "migration-failed";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

export interface CatalogUpgrade {
  from: number;
  to: number;
  /** Root-relative path of the verified pre-upgrade catalog snapshot. */
  snapshot: string;
}

export interface Library {
  readonly root: string;
  readonly libraryId: string;
  readonly schemaVersion: number;
  /** Private to storage/library services; never exposed to renderers. */
  readonly database: DatabaseSync;
  readonly created: boolean;
  readonly upgrade: CatalogUpgrade | null;
  readonly recoveredStaleLock: LockOwner | null;
  close(): void;
}

export interface OpenLibraryOptions {
  root: string;
  /** Tests substitute later schema versions; production uses the default. */
  migrations?: readonly Migration[];
  now?: () => number;
}

/**
 * Lock the root, then create, upgrade, or validate its catalog. Refusals
 * (newer, foreign or damaged catalogs) happen before any catalog write.
 */
export function openLibrary(options: OpenLibraryOptions): Library {
  const root = resolve(options.root);
  const migrations = options.migrations ?? catalogMigrations;
  const now = options.now ?? Date.now;
  assertConsecutive(migrations);
  mkdirSync(root, { recursive: true });
  const lock = acquireRootLock(root);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(root, CATALOG_FILE), { timeout: 5000 });
    const state = prepareCatalog(database, root, migrations, now);
    for (const directory of LIBRARY_DIRECTORIES)
      mkdirSync(join(root, directory), { recursive: true });
    return finish(root, database, lock, state);
  } catch (error) {
    try {
      database?.close();
    } finally {
      lock.release();
    }
    throw error;
  }
}

interface PreparedState {
  created: boolean;
  upgrade: CatalogUpgrade | null;
  schemaVersion: number;
}

function prepareCatalog(
  database: DatabaseSync,
  root: string,
  migrations: readonly Migration[],
  now: () => number,
): PreparedState {
  const latest = migrations.at(-1)?.version ?? 0;
  const location = join(root, CATALOG_FILE);
  let version: number;
  try {
    version = pragmaNumber(database, "user_version");
  } catch (error) {
    throw new CatalogError(
      "damaged",
      `The catalog at ${location} cannot be read (${message(error)}). It was not changed.`,
    );
  }
  if (version > latest) {
    throw new CatalogError(
      "newer-schema",
      `The catalog at ${location} uses schema ${version}, but this Borges build supports schema ${latest} at most. It was not changed; open it with a newer build.`,
    );
  }
  if (version === 0) {
    if (database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
      throw new CatalogError(
        "not-a-catalog",
        `${location} is a populated SQLite database without a Borges schema. It was not changed.`,
      );
    }
    migrate(database, migrations, 0, now(), null);
    configure(database);
    validate(database, location, migrations, latest);
    return { created: true, upgrade: null, schemaVersion: latest };
  }
  if (pragmaNumber(database, "application_id") !== CATALOG_APPLICATION_ID) {
    throw new CatalogError(
      "not-a-catalog",
      `${location} is not a Borges catalog. It was not changed.`,
    );
  }
  validate(database, location, migrations, version);
  let upgrade: CatalogUpgrade | null = null;
  if (version < latest) {
    const at = now();
    const snapshot = takeSnapshot(database, root, version, latest, at);
    upgrade = { from: version, to: latest, snapshot };
    migrate(database, migrations, version, at, snapshot);
  }
  configure(database);
  validate(database, location, migrations, latest);
  return { created: false, upgrade, schemaVersion: latest };
}

function finish(
  root: string,
  database: DatabaseSync,
  lock: RootLock,
  state: PreparedState,
): Library {
  const identity = database
    .prepare("SELECT library_id FROM library WHERE singleton = 1")
    .get();
  let closed = false;
  return {
    root,
    libraryId: String(identity?.library_id),
    database,
    recoveredStaleLock: lock.recoveredStale,
    ...state,
    close() {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        lock.release();
      }
    },
  };
}

/** One transaction for every pending version; failure leaves `from` intact. */
function migrate(
  database: DatabaseSync,
  migrations: readonly Migration[],
  from: number,
  now: number,
  snapshot: string | null,
): void {
  const pending = migrations.filter(({ version }) => version > from);
  const target = pending.at(-1)?.version ?? from;
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of pending) {
        migration.up(database, { now });
        database
          .prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
          .run(migration.version, migration.description, now);
        database.exec(`PRAGMA user_version = ${migration.version}`);
      }
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(
          `${violations.length} foreign-key violation(s), first in ${String(violations[0]?.table)}`,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back (for example on SQLITE_FULL).
      }
      throw error;
    }
  } catch (error) {
    throw new CatalogError(
      "migration-failed",
      from === 0
        ? `Creating the catalog failed (${message(error)}). No catalog was committed.`
        : `Upgrading the catalog from schema ${from} to ${target} failed (${message(error)}). It remains at schema ${from}; a pre-upgrade snapshot is at ${snapshot}.`,
    );
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function configure(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  const mode = database.prepare("PRAGMA journal_mode = WAL").get();
  if (mode?.journal_mode !== "wal") {
    throw new CatalogError(
      "damaged",
      `The catalog could not use write-ahead logging (mode ${String(mode?.journal_mode)}).`,
    );
  }
  // One fsync per commit in WAL mode; committed progress survives power loss.
  database.exec("PRAGMA synchronous = FULL");
}

/**
 * Compare the stored schema with the one the migrations produce from scratch.
 * Migrations are deterministic, so any missing/altered object means damage.
 */
function validate(
  database: DatabaseSync,
  location: string,
  migrations: readonly Migration[],
  version: number,
): void {
  const expected = new DatabaseSync(":memory:");
  let wanted: string[];
  try {
    expected.exec("BEGIN");
    for (const migration of migrations.filter((m) => m.version <= version))
      migration.up(expected, { now: 0 });
    wanted = schemaObjects(expected);
  } finally {
    expected.close();
  }
  let actual: string[];
  let identities: number;
  try {
    actual = schemaObjects(database);
    identities = Number(
      database.prepare("SELECT count(*) AS n FROM library").get()?.n,
    );
  } catch (error) {
    throw new CatalogError(
      "damaged",
      `The catalog at ${location} is damaged (${message(error)}). It was not changed.`,
    );
  }
  const missing = wanted.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !wanted.includes(entry));
  if (missing.length > 0 || extra.length > 0 || identities !== 1) {
    const differences = [...missing, ...extra]
      .map((entry) => entry.split("\n", 1)[0])
      .slice(0, 3);
    throw new CatalogError(
      "damaged",
      `The catalog at ${location} does not match schema ${version}${
        identities !== 1 ? " (library identity is missing)" : ""
      }${differences.length ? `: ${differences.join("; ")}` : ""}. It was not changed.`,
    );
  }
}

function schemaObjects(database: DatabaseSync): string[] {
  return database
    .prepare(
      "SELECT type, name, coalesce(sql, '') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .all()
    .map((row) => `${row.type} ${row.name}\n${row.sql}`);
}

/**
 * Consistent, verified catalog copy inside the root before any upgrade. It is
 * written under a temporary name and renamed only after verification.
 */
function takeSnapshot(
  database: DatabaseSync,
  root: string,
  from: number,
  to: number,
  now: number,
): string {
  const directory = resolveLibraryPath(root, "recovery");
  mkdirSync(directory, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const base = `catalog-schema-${from}-before-${to}-${stamp}`;
  const temporary = join(directory, `.${base}.${randomUUID()}.partial`);
  try {
    database.prepare("VACUUM INTO ?").run(temporary);
    const copy = new DatabaseSync(temporary, { readOnly: true });
    try {
      const check = copy.prepare("PRAGMA quick_check").get()?.quick_check;
      if (pragmaNumber(copy, "user_version") !== from || check !== "ok") {
        throw new Error(`snapshot verification failed (${String(check)})`);
      }
    } finally {
      copy.close();
    }
    syncPath(temporary);
    let target = join(directory, `${base}.sqlite`);
    for (let n = 2; existsSync(target); n++)
      target = join(directory, `${base}-${n}.sqlite`);
    renameSync(temporary, target);
    syncPath(directory);
    return toLibraryPath(root, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new CatalogError(
      "migration-failed",
      `A pre-upgrade catalog snapshot could not be written (${message(error)}). The catalog was not upgraded or changed.`,
    );
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  return Number(database.prepare(`PRAGMA ${name}`).get()?.[name]);
}

function assertConsecutive(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new Error("Catalog migrations must be numbered 1, 2, 3, ….");
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
