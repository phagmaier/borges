import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CatalogError,
  type Library,
  openLibrary,
} from "../../src/storage/catalog";
import { acquireRootLock, LibraryLockedError } from "../../src/storage/lock";
import {
  isLibraryPath,
  resolveExistingLibraryPath,
  resolveLibraryPath,
  resolveLibraryRoot,
  toLibraryPath,
} from "../../src/storage/paths";
import { catalogMigrations, type Migration } from "../../src/storage/schema";

let temporary: string;
let root: string;
const open: Library[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "borges-catalog-"));
  root = join(temporary, "library");
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const library of open.splice(0)) library.close();
  rmSync(temporary, { recursive: true, force: true });
});

function openAt(path = root, migrations?: readonly Migration[]): Library {
  const library = openLibrary({
    root: path,
    ...(migrations ? { migrations } : {}),
  });
  open.push(library);
  return library;
}

function closeAll() {
  for (const library of open.splice(0)) library.close();
}

/** Insert a live book with its current revision, as one transaction. */
function addBook(
  database: DatabaseSync,
  { book, revision, title }: { book: string; revision: string; title: string },
) {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        "INSERT INTO books (id, current_revision_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      )
      .run(book, revision, title);
    database
      .prepare(
        "INSERT INTO revisions (id, book_id, format, path, sha256, size, original_filename, created_at) VALUES (?, ?, 'pdf', ?, ?, 3, 'a.pdf', 1)",
      )
      .run(revision, book, `files/${revision}.pdf`, "a".repeat(64));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function external(path = join(root, "catalog.sqlite")) {
  return new DatabaseSync(path);
}

function catalogError(action: () => unknown): CatalogError {
  try {
    action();
  } catch (error) {
    if (error instanceof CatalogError) return error;
    throw error;
  }
  throw new Error("expected a CatalogError");
}

function startChild(mode: string, ready: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [resolve("tests/unit/storage-child.ts"), mode, root],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  return new Promise((done, fail) => {
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes(ready)) done(child);
    });
    child.on("exit", (code) => fail(new Error(`child exited ${code}`)));
  });
}

async function kill(child: ChildProcess) {
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
}

describe("library root and durable paths", () => {
  it.each([
    [{ explicitRoot: "/srv/books", home: "/home/u" }, "/srv/books"],
    [
      { explicitRoot: "/srv/books/", xdgDataHome: "/x", home: "/home/u" },
      "/srv/books",
    ],
    [
      { developmentProfile: "/tmp/profile", home: "/home/u" },
      "/tmp/profile/library",
    ],
    [{ xdgDataHome: "/data", home: "/home/u" }, "/data/borges/library"],
    // XDG: a relative value is invalid and ignored.
    [
      { xdgDataHome: "data", home: "/home/u" },
      "/home/u/.local/share/borges/library",
    ],
    [{ home: "/home/u" }, "/home/u/.local/share/borges/library"],
  ])("resolves %o to %s", (inputs, expected) => {
    expect(resolveLibraryRoot(inputs)).toBe(expected);
  });

  it("rejects a relative explicit root rather than depending on cwd", () => {
    expect(() =>
      resolveLibraryRoot({ explicitRoot: "books", home: "/home/u" }),
    ).toThrow("absolute path");
  });

  it.each([
    ["files/a.pdf", true],
    ["covers/x/y.png", true],
    ["", false],
    ["/etc/passwd", false],
    ["../outside", false],
    ["files/../../outside", false],
    ["files/./a", false],
    ["files//a", false],
    ["files\\a", false],
    ["files/a\0", false],
  ])("isLibraryPath(%j) is %s", (path, valid) => {
    expect(isLibraryPath(path)).toBe(valid);
  });

  it("converts inside paths and rejects outside ones", () => {
    expect(toLibraryPath("/lib", "/lib/files/a.pdf")).toBe("files/a.pdf");
    expect(() => toLibraryPath("/lib", "/elsewhere/a.pdf")).toThrow(
      "outside the library root",
    );
    expect(() => toLibraryPath("/lib", "/lib")).toThrow();
    expect(resolveLibraryPath("/new/lib", "files/a.pdf")).toBe(
      "/new/lib/files/a.pdf",
    );
  });

  it("rejects an existing path that escapes the root through a symlink", async () => {
    mkdirSync(join(root, "files"), { recursive: true });
    writeFileSync(join(temporary, "secret.pdf"), "x");
    writeFileSync(join(root, "files/inside.pdf"), "y");
    symlinkSync(join(temporary, "secret.pdf"), join(root, "files/link.pdf"));
    await expect(
      resolveExistingLibraryPath(root, "files/inside.pdf"),
    ).resolves.toBe(join(root, "files/inside.pdf"));
    await expect(
      resolveExistingLibraryPath(root, "files/link.pdf"),
    ).rejects.toThrow("escapes the library root");
  });
});

describe("catalog creation and identity", () => {
  it("creates the root layout and a versioned, identified catalog once", () => {
    const first = openAt();
    expect(first).toMatchObject({
      created: true,
      upgrade: null,
      schemaVersion: 1,
    });
    expect(first.libraryId).toMatch(/^[0-9a-f-]{36}$/);
    for (const directory of ["files", "covers", "staging", "recovery"])
      expect(existsSync(join(root, directory))).toBe(true);
    addBook(first.database, {
      book: "b1",
      revision: "r1",
      title: "Ficciones — 蘭",
    });
    const id = first.libraryId;
    closeAll();
    // Clean close checkpoints the WAL and removes transient lock state, so a
    // closed library is safe to copy as a plain folder.
    expect(readdirSync(root).sort()).toEqual([
      "catalog.sqlite",
      "covers",
      "files",
      "library.lock",
      "recovery",
      "staging",
    ]);

    const database = external();
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect(database.prepare("PRAGMA application_id").get()).toEqual({
        application_id: 0x426f7267,
      });
      expect(
        database.prepare("SELECT version FROM schema_migrations").all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }

    const second = openAt();
    expect(second).toMatchObject({ created: false, libraryId: id });
    expect(second.database.prepare("SELECT title FROM books").get()).toEqual({
      title: "Ficciones — 蘭",
    });
    expect(readdirSync(join(root, "recovery"))).toEqual([]);
  });

  it("works from a copied root after the original is moved away", () => {
    const library = openAt();
    addBook(library.database, { book: "b1", revision: "r1", title: "Copied" });
    const id = library.libraryId;
    closeAll();
    const copy = join(temporary, "restored/library");
    cpSync(root, copy, { recursive: true });
    renameSync(root, join(temporary, "original-moved"));

    const restored = openAt(copy);
    expect(restored.libraryId).toBe(id);
    const path = restored.database
      .prepare("SELECT path FROM revisions WHERE id = 'r1'")
      .get()?.path;
    expect(resolveLibraryPath(restored.root, String(path))).toBe(
      join(copy, "files/r1.pdf"),
    );
    restored.database.exec("UPDATE books SET title = 'Only in copy'");
    closeAll();
    const original = external(join(temporary, "original-moved/catalog.sqlite"));
    try {
      expect(original.prepare("SELECT title FROM books").get()?.title).toBe(
        "Copied",
      );
    } finally {
      original.close();
    }
  });
});

describe("catalog schema invariants", () => {
  let database: DatabaseSync;
  beforeEach(() => {
    database = openAt().database;
    addBook(database, { book: "b1", revision: "r1", title: "One" });
    addBook(database, { book: "b2", revision: "r2", title: "Two" });
  });
  const run = (sql: string, ...values: (string | number | null)[]) =>
    database.prepare(sql).run(...values);

  it("requires a book's current revision to exist and belong to that book", () => {
    expect(() =>
      run("UPDATE books SET current_revision_id = 'r2' WHERE id = 'b1'"),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      run(
        "INSERT INTO books (id, current_revision_id, title, created_at, updated_at) VALUES ('b3', 'missing', 'x', 1, 1)",
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() => run("UPDATE books SET title = '   ' WHERE id = 'b1'")).toThrow(
      /CHECK/,
    );
  });

  it.each([
    "/abs/r9.pdf",
    "files/../r9.pdf",
    "../r9.pdf",
    "files//r9.pdf",
    "files/./r9.pdf",
    "covers/r9.pdf",
    "files/",
    "files\\r9.pdf",
  ])("rejects non-durable revision path %j", (path) => {
    expect(() =>
      run(
        "INSERT INTO revisions (id, book_id, format, path, sha256, size, original_filename, created_at) VALUES ('r9', 'b1', 'pdf', ?, ?, 1, 'x', 1)",
        path,
        "b".repeat(64),
      ),
    ).toThrow(/CHECK/);
  });

  it("keeps positions format-specific and attached to a revision", () => {
    run(
      "INSERT INTO positions (revision_id, format, pdf_page, pan_x, pan_y, sequence, updated_at) VALUES ('r1', 'pdf', 3, 0.5, 0.25, 1, 1)",
    );
    // r2 is a PDF revision: an EPUB locator cannot be attached to it.
    expect(() =>
      run(
        "INSERT INTO positions (revision_id, format, epub_cfi, epub_section, epub_fraction, sequence, updated_at) VALUES ('r2', 'epub', 'epubcfi(/6/2)', 0, 0.1, 1, 1)",
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      run(
        "INSERT INTO positions (revision_id, format, pdf_page, epub_cfi, sequence, updated_at) VALUES ('r2', 'pdf', 1, 'mixed', 1, 1)",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run("UPDATE positions SET pan_x = 1.5 WHERE revision_id = 'r1'"),
    ).toThrow(/CHECK/);
  });

  it("enforces sibling names, rejects cycles, and deletes branches without books", () => {
    const section = (id: string, parent: string | null, key: string) =>
      run(
        "INSERT INTO sections (id, parent_id, name, name_key, created_at) VALUES (?, ?, ?, ?, 1)",
        id,
        parent,
        key.toUpperCase(),
        key,
      );
    section("root-a", null, "history");
    expect(() => section("root-b", null, "history")).toThrow(/UNIQUE/);
    section("child", "root-a", "history"); // Same name, different parent.
    section("grandchild", "child", "rome");
    expect(() =>
      run(
        "INSERT INTO sections (id, parent_id, name, name_key, created_at) VALUES ('padded', NULL, ' Padded ', 'padded', 1)",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run("UPDATE sections SET parent_id = 'grandchild' WHERE id = 'root-a'"),
    ).toThrow("section cycle");
    expect(() =>
      run("UPDATE sections SET parent_id = 'child' WHERE id = 'child'"),
    ).toThrow();

    section("other", null, "other");
    for (const [id, book] of [
      ["grandchild", "b1"],
      ["other", "b1"],
      ["child", "b2"],
    ])
      run(
        "INSERT INTO section_memberships VALUES (?, ?, 1)",
        id as string,
        book as string,
      );
    expect(() =>
      run("INSERT INTO section_memberships VALUES ('other', 'b1', 2)"),
    ).toThrow(/UNIQUE|PRIMARY KEY/);

    run("DELETE FROM sections WHERE id = 'root-a'");
    expect(
      database.prepare("SELECT id FROM sections ORDER BY id").all(),
    ).toEqual([{ id: "other" }]);
    expect(
      database
        .prepare("SELECT section_id, book_id FROM section_memberships")
        .all(),
    ).toEqual([{ section_id: "other", book_id: "b1" }]);
    expect(database.prepare("SELECT count(*) AS n FROM books").get()?.n).toBe(
      2,
    );
  });

  it("deduplicates subjects by key and keeps trash entries well-formed", () => {
    run("INSERT INTO book_subjects VALUES ('b1', 'Poetry', 'poetry')");
    expect(() =>
      run("INSERT INTO book_subjects VALUES ('b1', 'POETRY', 'poetry')"),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    run(
      "INSERT INTO trash_entries (id, kind, book_id, trashed_at) VALUES ('t1', 'book', 'b1', 1)",
    );
    expect(() =>
      run(
        "INSERT INTO trash_entries (id, kind, book_id, revision_id, trashed_at) VALUES ('t2', 'book', 'b2', 'r2', 1)",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        "INSERT INTO trash_entries (id, kind, book_id, trashed_at) VALUES ('t3', 'book', 'b1', 2)",
      ),
    ).toThrow(/UNIQUE/);
    run(
      "INSERT INTO trash_entries (id, kind, book_id, revision_id, trashed_at) VALUES ('t4', 'revision', 'b2', 'r2', 1)",
    );
    // r1 belongs to b1, so it cannot be trashed as a revision of b2.
    expect(() =>
      run(
        "INSERT INTO trash_entries (id, kind, book_id, revision_id, trashed_at) VALUES ('t5', 'revision', 'b2', 'r1', 1)",
      ),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("catalog refusal leaves the database unchanged", () => {
  function prepareThenRefuse(
    sql: string,
    expected: { code: string; text: string },
    { fromCatalog = true } = {},
  ) {
    if (fromCatalog) {
      addBook(openAt().database, { book: "b1", revision: "r1", title: "Keep" });
      closeAll();
    } else {
      mkdirSync(root, { recursive: true });
    }
    const database = external();
    database.exec(sql);
    database.close();
    const path = join(root, "catalog.sqlite");
    const before = readFileSync(path);
    const error = catalogError(() => openAt());
    expect(error.code).toBe(expected.code);
    expect(error.message).toContain(expected.text);
    expect(error.message).toContain("not changed");
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
    // The refused open released the root lock.
    acquireRootLock(root).release();
  }

  it("refuses a newer schema", () => {
    prepareThenRefuse(
      "PRAGMA user_version = 2; CREATE TABLE future_data (v TEXT); INSERT INTO future_data VALUES ('retain');",
      { code: "newer-schema", text: "uses schema 2" },
    );
    expect(readdirSync(join(root, "recovery"))).toEqual([]);
  });

  it("refuses a populated unversioned database", () => {
    prepareThenRefuse(
      "CREATE TABLE other (v TEXT); INSERT INTO other VALUES ('preserve');",
      { code: "not-a-catalog", text: "without a Borges schema" },
      { fromCatalog: false },
    );
  });

  it("refuses another application's versioned database", () => {
    prepareThenRefuse(
      "PRAGMA user_version = 1; PRAGMA application_id = 7; CREATE TABLE other (v TEXT);",
      { code: "not-a-catalog", text: "not a Borges catalog" },
      { fromCatalog: false },
    );
  });

  it.each([
    ["a dropped table", "DROP TABLE trash_entries"],
    ["a dropped index", "DROP INDEX revisions_by_hash"],
    ["an altered table", "ALTER TABLE books ADD COLUMN stray TEXT"],
    ["a missing identity", "DELETE FROM library"],
  ])("refuses a damaged supported schema: %s", (_, sql) => {
    prepareThenRefuse(sql, {
      code: "damaged",
      text: "does not match schema 1",
    });
  });

  it("refuses an unreadable catalog file", () => {
    mkdirSync(root, { recursive: true });
    const path = join(root, "catalog.sqlite");
    writeFileSync(path, "not a database, but someone's bytes".repeat(200));
    const before = readFileSync(path);
    expect(catalogError(() => openAt()).code).toBe("damaged");
    expect(readFileSync(path)).toEqual(before);
  });
});

describe("forward-only upgrades", () => {
  const version2: Migration = {
    version: 2,
    description: "Sortable titles",
    up(database) {
      database.exec(`
        ALTER TABLE books ADD COLUMN sort_title TEXT;
        UPDATE books SET sort_title = lower(title);
      `);
    },
  };

  function seedVersion1() {
    addBook(openAt().database, {
      book: "b1",
      revision: "r1",
      title: "The Aleph",
    });
    closeAll();
  }

  it("snapshots the old catalog inside the root, then upgrades once", () => {
    seedVersion1();
    const upgraded = openAt(root, [...catalogMigrations, version2]);
    expect(upgraded.upgrade).toMatchObject({ from: 1, to: 2 });
    expect(upgraded.schemaVersion).toBe(2);
    expect(
      upgraded.database.prepare("SELECT sort_title FROM books").get(),
    ).toEqual({ sort_title: "the aleph" });
    const snapshot = String(upgraded.upgrade?.snapshot);
    expect(snapshot).toMatch(
      /^recovery\/catalog-schema-1-before-2-.*\.sqlite$/,
    );
    closeAll();

    const copy = new DatabaseSync(resolveLibraryPath(root, snapshot), {
      readOnly: true,
    });
    try {
      expect(copy.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(copy.prepare("SELECT title FROM books").get()?.title).toBe(
        "The Aleph",
      );
    } finally {
      copy.close();
    }
    const again = openAt(root, [...catalogMigrations, version2]);
    expect(again.upgrade).toBeNull();
    expect(
      again.database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(readdirSync(join(root, "recovery"))).toHaveLength(1);
    // The upgraded catalog is now newer than a version-1 build supports.
    closeAll();
    expect(catalogError(() => openAt()).code).toBe("newer-schema");
  });

  it.each([
    [
      "throws after partial work",
      (database: DatabaseSync) => {
        database.exec("UPDATE books SET title = 'CORRUPTED'");
        database.exec("DROP TABLE trash_entries");
        throw new Error("injected migration failure");
      },
      "injected migration failure",
    ],
    [
      "leaves a foreign-key violation",
      (database: DatabaseSync) => {
        database.exec("DELETE FROM revisions");
      },
      "foreign-key violation",
    ],
  ])("rolls back a migration that %s", (_, up, text) => {
    seedVersion1();
    const error = catalogError(() =>
      openAt(root, [
        ...catalogMigrations,
        { version: 2, description: "Broken", up },
      ]),
    );
    expect(error.code).toBe("migration-failed");
    expect(error.message).toContain(text);
    expect(error.message).toContain("remains at schema 1");
    // A version-1 build still opens the intact catalog with its data.
    const intact = openAt();
    expect(intact.database.prepare("SELECT title FROM books").get()).toEqual({
      title: "The Aleph",
    });
    closeAll();
    expect(readdirSync(join(root, "recovery"))).toHaveLength(1);
    const fixed = openAt(root, [...catalogMigrations, version2]);
    expect(fixed.upgrade?.from).toBe(1);
  });

  it("recovers the old catalog after the process is killed mid-upgrade", async () => {
    seedVersion1();
    const child = await startChild("crash-during-upgrade", "migrating");
    // Uncommitted upgrade pages reached the WAL before the kill.
    expect(existsSync(join(root, "catalog.sqlite-wal"))).toBe(true);
    await kill(child);

    const intact = openAt();
    expect(intact.schemaVersion).toBe(1);
    expect(intact.database.prepare("SELECT title FROM books").get()).toEqual({
      title: "The Aleph",
    });
    // The killed holder's lock was released by the kernel and recovered.
    expect(intact.recoveredStaleLock?.pid).toBe(child.pid);
    closeAll();
    expect(openAt(root, [...catalogMigrations, version2]).upgrade?.to).toBe(2);
  });
});

describe("exclusive library-root lock", () => {
  it("refuses a second holder in the same process until released", () => {
    const first = openAt();
    let error: unknown;
    try {
      openAt();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LibraryLockedError);
    expect((error as LibraryLockedError).owner?.pid).toBe(process.pid);
    expect(String((error as Error).message)).toContain("in use by another");
    first.close();
    expect(openAt().recoveredStaleLock).toBeNull();
  });

  it("explains a live holder in another process and recovers only after it dies", async () => {
    const child = await startChild("hold-lock", "locked");
    let error: unknown;
    try {
      openAt();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LibraryLockedError);
    expect((error as LibraryLockedError).owner?.pid).toBe(child.pid);
    expect(existsSync(join(root, "catalog.sqlite"))).toBe(false);

    await kill(child);
    const library = openAt();
    expect(library.recoveredStaleLock?.pid).toBe(child.pid);
    const owner = JSON.parse(
      readFileSync(join(root, "library.lock-owner.json"), "utf8"),
    );
    expect(owner.pid).toBe(process.pid);
    library.close();
    expect(existsSync(join(root, "library.lock-owner.json"))).toBe(false);
  });

  it("does not trust an owner record without a live kernel lock", () => {
    mkdirSync(root, { recursive: true });
    // A forged/stale record naming this live process must not block startup.
    writeFileSync(
      join(root, "library.lock-owner.json"),
      JSON.stringify({ token: "forged", pid: process.pid, hostname: "h" }),
    );
    expect(openAt().recoveredStaleLock?.token).toBe("forged");
  });
});
