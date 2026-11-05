import {
  chmodSync,
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
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setManualCover } from "../../src/library/covers";
import { addFileAsNewBook, replaceBookFile } from "../../src/library/import";
import { beginReaderSession, saveProgress } from "../../src/library/progress";
import { emptyTrash } from "../../src/library/purge";
import { queryBooks } from "../../src/library/query";
import { reconcileOperations } from "../../src/library/recovery";
import { restoreRevision } from "../../src/library/revision-restore";
import {
  deleteBook,
  listTrash,
  restoreDeletedBook,
} from "../../src/library/trash";
import { type Library, openLibrary } from "../../src/storage/catalog";

import { kill, killChildren, startChild } from "./library-fixtures";

let library: Library;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "borges-purge-"));
  library = openLibrary({ root });
});
afterEach(() => {
  killChildren();
  library.close();
  rmSync(root, { recursive: true, force: true });
});
const source = "tests/fixtures/known.pdf";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=",
  "base64",
);

it("purges a deleted book and all its retired revisions, preserving sources and a live book", async () => {
  const before = readFileSync(source);
  const book = await addFileAsNewBook(library, source);
  await replaceBookFile(library, book.bookId, "tests/fixtures/reflowable.epub");
  deleteBook(library.database, book.bookId);
  const live = await addFileAsNewBook(library, "tests/fixtures/image-only.pdf");
  expect(await emptyTrash(library)).toMatchObject({ purged: 2, failures: [] });
  expect((await listTrash(library)).entries).toEqual([]);
  expect(readdirSync(join(root, "files"))).toEqual([live.path.slice(6)]);
  expect(readFileSync(source)).toEqual(before);
  expect(queryBooks(library.database, { view: { kind: "all" } })).toMatchObject(
    [{ id: live.bookId }],
  );
  expect(library.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
    [],
  );
});

it("purges only a retired revision of a live book and preserves shared/live covers and the live position", async () => {
  const cover = png;
  const book = await addFileAsNewBook(library, source, {
    inspect: async () => ({
      title: "Atlas",
      authors: [],
      subjects: [],
      cover,
      warnings: [],
    }),
  });
  await replaceBookFile(library, book.bookId, "tests/fixtures/reflowable.epub");
  const session = beginReaderSession(library.database, book.bookId);
  saveProgress(library.database, {
    ...session,
    sequence: 1,
    location: {
      format: "epub",
      cfi: "epubcfi(/6/2!/4/2/1:0)",
      section: 0,
      x: 0,
      y: 0,
      fraction: 0.25,
    },
    sizing: { fontSize: 18, zoom: 1 },
  });
  const oldCover = library.database
    .prepare("SELECT extracted_cover_path AS path FROM revisions WHERE id = ?")
    .get(book.revisionId)?.path as string;
  // A live manual choice uses the same retained cover: purge must keep it.
  library.database
    .prepare("UPDATE books SET cover_path = ?, cover_manual = 1 WHERE id = ?")
    .run(oldCover, book.bookId);
  expect(await emptyTrash(library)).toMatchObject({ purged: 1, failures: [] });
  expect(existsSync(join(root, book.path))).toBe(false);
  expect(readFileSync(join(root, oldCover))).toEqual(cover);
  expect(queryBooks(library.database, { view: { kind: "all" } })).toHaveLength(
    1,
  );
  expect(
    beginReaderSession(library.database, book.bookId).location,
  ).toMatchObject({ format: "epub", fraction: 0.25 });
  deleteBook(library.database, book.bookId);
  expect(await emptyTrash(library)).toMatchObject({ purged: 1, failures: [] });
  expect(readdirSync(join(root, "files"))).toEqual([]);
  expect(readdirSync(join(root, "covers"))).toEqual([]);
});

it("cleans verified superseded manual covers while preserving unrelated/unknown files", async () => {
  writeFileSync(join(root, "source.png"), png);
  const book = await addFileAsNewBook(library, source);
  await setManualCover(library, book.bookId, join(root, "source.png"), {
    normalize: (bytes) => bytes,
  });
  await setManualCover(library, book.bookId, join(root, "source.png"), {
    normalize: (bytes) => bytes,
  });
  writeFileSync(join(root, "covers/unknown.png"), "UNKNOWN");
  writeFileSync(join(root, "files/unknown.pdf"), "UNKNOWN");
  deleteBook(library.database, book.bookId);
  expect(await emptyTrash(library)).toMatchObject({ purged: 1, failures: [] });
  expect(readdirSync(join(root, "covers"))).toEqual(["unknown.png"]);
  expect(readdirSync(join(root, "files"))).toEqual(["unknown.pdf"]);
  expect((await reconcileOperations(library)).unrecognized).toEqual([
    "files/unknown.pdf",
    "covers/unknown.png",
  ]);
});

it("keeps I/O failures visible and retryable and blocks restoration after removal starts", async () => {
  const book = await addFileAsNewBook(library, source);
  const entry = deleteBook(library.database, book.bookId);
  const other = await addFileAsNewBook(
    library,
    "tests/fixtures/reflowable.epub",
  );
  deleteBook(library.database, other.bookId);
  chmodSync(join(root, "files"), 0o555);
  try {
    expect((await emptyTrash(library)).failures).toHaveLength(2);
    expect((await listTrash(library)).entries[0]?.purgeProblem).toContain(
      "Retry Empty Trash",
    );
    await expect(restoreDeletedBook(library, entry.id)).rejects.toThrow(
      "unfinished",
    );
    await expect(
      restoreRevision(library, entry.id, "separate"),
    ).rejects.toThrow("unfinished");
  } finally {
    chmodSync(join(root, "files"), 0o755);
  }
  expect(await emptyTrash(library)).toMatchObject({ purged: 2, failures: [] });
  expect((await listTrash(library)).entries).toEqual([]);
});

it.each(["modified", "symlink", "directory"])(
  "preserves %s bytes for repair, permits retry, and purges an independent entry",
  async (problem) => {
    const book = await addFileAsNewBook(library, source);
    deleteBook(library.database, book.bookId);
    const path = join(root, book.path);
    rmSync(path);
    if (problem === "modified") writeFileSync(path, "NOT THE RECORDED FILE");
    else if (problem === "symlink")
      symlinkSync(join(process.cwd(), source), path);
    else mkdirSync(path);
    const other = await addFileAsNewBook(
      library,
      "tests/fixtures/reflowable.epub",
    );
    deleteBook(library.database, other.bookId);
    const result = await emptyTrash(library);
    expect(result.purged).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(existsSync(path)).toBe(true);
    expect((await listTrash(library)).entries).toHaveLength(1);
    rmSync(path, { recursive: true });
    writeFileSync(path, readFileSync(source));
    expect(await emptyTrash(library)).toMatchObject({
      purged: 1,
      failures: [],
    });
  },
);

it("refuses symlinked managed directories and never touches their targets", async () => {
  const book = await addFileAsNewBook(library, source);
  deleteBook(library.database, book.bookId);
  renameSync(join(root, "files"), join(root, "kept-files"));
  symlinkSync(join(root, "kept-files"), join(root, "files"));
  expect((await emptyTrash(library)).failures[0]?.message).toContain(
    "Unsafe managed directory",
  );
  expect(readFileSync(join(root, "kept-files", book.path.slice(6)))).toEqual(
    readFileSync(source),
  );
});

it("refuses stale confirmations before any removal and preserves live data if an interrupted purge's catalog changes", async () => {
  const book = await addFileAsNewBook(library, source);
  deleteBook(library.database, book.bookId);
  await expect(emptyTrash(library, { expectedEntryIds: [] })).rejects.toThrow(
    "Trash changed",
  );
  expect(readFileSync(join(root, book.path))).toEqual(readFileSync(source));
  chmodSync(join(root, "files"), 0o555);
  try {
    await emptyTrash(library);
  } finally {
    chmodSync(join(root, "files"), 0o755);
  }
  // Simulate inconsistent catalog edits outside the app after an interruption.
  library.database
    .prepare("UPDATE books SET deleted_at = NULL WHERE id = ?")
    .run(book.bookId);
  expect((await reconcileOperations(library)).operations[0]?.outcome).toBe(
    "retained",
  );
  expect(readFileSync(join(root, book.path))).toEqual(readFileSync(source));
});

it("keeps a failed catalog commit retryable even when bytes have already been removed", async () => {
  const book = await addFileAsNewBook(library, source);
  const entry = deleteBook(library.database, book.bookId);
  library.database.exec(
    "CREATE TRIGGER refuse_purge BEFORE DELETE ON trash_entries BEGIN SELECT RAISE(ABORT, 'catalog full'); END",
  );
  expect((await emptyTrash(library)).failures[0]?.message).toContain(
    "catalog full",
  );
  expect(existsSync(join(root, book.path))).toBe(false);
  expect((await listTrash(library)).entries).toMatchObject([
    { id: entry.id, fileProblem: true },
  ]);
  await expect(restoreDeletedBook(library, entry.id)).rejects.toThrow(
    "unfinished",
  );
  library.database.exec("DROP TRIGGER refuse_purge");
  expect((await reconcileOperations(library)).operations[0]?.outcome).toBe(
    "purged",
  );
  expect((await listTrash(library)).entries).toEqual([]);
  expect(library.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
    [],
  );
});

it("purges already-missing Trash files without mistaking a live file for a missing purge artifact", async () => {
  const book = await addFileAsNewBook(library, source);
  deleteBook(library.database, book.bookId);
  rmSync(join(root, book.path));
  const live = await addFileAsNewBook(library, "tests/fixtures/image-only.pdf");
  expect(await emptyTrash(library)).toMatchObject({ purged: 1, failures: [] });
  expect(existsSync(join(root, live.path))).toBe(true);
});

it.each(["recorded", "removed", "files-removed", "committing", "committed"])(
  "resumes a confirmed purge after SIGKILL at %s",
  async (step) => {
    const book = await addFileAsNewBook(library, source, {
      inspect: async () => ({
        title: "Atlas",
        authors: [],
        subjects: [],
        cover: png,
        warnings: [],
      }),
    });
    await replaceBookFile(
      library,
      book.bookId,
      "tests/fixtures/reflowable.epub",
    );
    deleteBook(library.database, book.bookId);
    library.close();
    const child = await startChild("purge-and-stop", root, `at ${step}`, step);
    await kill(child);
    library = openLibrary({ root });
    await reconcileOperations(library);
    expect((await listTrash(library)).entries).toEqual([]);
    expect(readdirSync(join(root, "files"))).toEqual([]);
    expect(readdirSync(join(root, "covers"))).toEqual([]);
    expect(library.database.prepare("SELECT * FROM books").all()).toEqual([]);
    expect(library.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
    expect(readFileSync(source).subarray(0, 5).toString()).toBe("%PDF-");
  },
);

it("does not remove bytes if the durable purge intent cannot be recorded", async () => {
  const book = await addFileAsNewBook(library, source);
  deleteBook(library.database, book.bookId);
  library.database.exec(
    "CREATE TRIGGER refuse_intent BEFORE INSERT ON recovery_operations WHEN NEW.kind = 'purge' BEGIN SELECT RAISE(ABORT, 'intent failed'); END",
  );
  expect((await emptyTrash(library)).failures[0]?.message).toContain(
    "intent failed",
  );
  expect(readFileSync(join(root, book.path))).toEqual(readFileSync(source));
  expect((await listTrash(library)).entries[0]?.purgeProblem).toContain(
    "intent failed",
  );
  library.database.exec("DROP TRIGGER refuse_intent");
  expect(await emptyTrash(library)).toMatchObject({ purged: 1, failures: [] });
});

it("retains modified cover bytes after removing a book file and resumes after repair", async () => {
  const book = await addFileAsNewBook(library, source, {
    inspect: async () => ({
      title: "Atlas",
      authors: [],
      subjects: [],
      cover: png,
      warnings: [],
    }),
  });
  const path = library.database
    .prepare("SELECT cover_path FROM books WHERE id = ?")
    .get(book.bookId)?.cover_path as string;
  deleteBook(library.database, book.bookId);
  writeFileSync(join(root, path), "UNKNOWN COVER");
  expect((await emptyTrash(library)).failures[0]?.message).toContain(
    "recorded content",
  );
  expect(existsSync(join(root, book.path))).toBe(false);
  expect(readFileSync(join(root, path)).toString()).toBe("UNKNOWN COVER");
  writeFileSync(join(root, path), png);
  expect((await reconcileOperations(library)).operations[0]?.outcome).toBe(
    "purged",
  );
  expect((await listTrash(library)).entries).toEqual([]);
});

it("does not report intentionally purged earlier covers as missing when the live owner is deleted later", async () => {
  const inspect = async () => ({
    title: "Atlas",
    authors: [],
    subjects: [],
    cover: png,
    warnings: [],
  });
  const book = await addFileAsNewBook(library, source, { inspect });
  await replaceBookFile(
    library,
    book.bookId,
    "tests/fixtures/reflowable.epub",
    { inspect },
  );
  expect(await emptyTrash(library)).toMatchObject({ purged: 1, failures: [] });
  expect(readdirSync(join(root, "covers"))).toHaveLength(1);
  deleteBook(library.database, book.bookId);
  expect(await listTrash(library)).toMatchObject({
    unavailableFiles: 0,
    bytes: readFileSync("tests/fixtures/reflowable.epub").length + png.length,
  });
  expect(await emptyTrash(library)).toMatchObject({ purged: 1, failures: [] });
  expect(readdirSync(join(root, "covers"))).toEqual([]);
});

it("can finish independently pending purges when another purge removes a shared superseded cover first", async () => {
  writeFileSync(join(root, "source.png"), png);
  const first = await addFileAsNewBook(library, source);
  const second = await addFileAsNewBook(
    library,
    "tests/fixtures/image-only.pdf",
  );
  const oldCover = await setManualCover(
    library,
    first.bookId,
    join(root, "source.png"),
    { normalize: (bytes) => bytes },
  );
  await setManualCover(library, first.bookId, join(root, "source.png"), {
    normalize: (bytes) => bytes,
  });
  library.database
    .prepare("UPDATE books SET cover_path = ?, cover_manual = 1 WHERE id = ?")
    .run(oldCover.path, second.bookId);
  deleteBook(library.database, first.bookId);
  deleteBook(library.database, second.bookId);
  chmodSync(join(root, "files"), 0o555);
  try {
    expect((await emptyTrash(library)).failures).toHaveLength(2);
  } finally {
    chmodSync(join(root, "files"), 0o755);
  }
  const operation = (bookId: string) =>
    String(
      library.database
        .prepare(
          "SELECT id FROM recovery_operations WHERE kind = 'purge' AND book_id = ?",
        )
        .get(bookId)?.id,
    );
  const { resumePurge } = await import("../../src/library/purge");
  expect((await resumePurge(library, operation(second.bookId))).outcome).toBe(
    "purged",
  );
  expect((await resumePurge(library, operation(first.bookId))).outcome).toBe(
    "purged",
  );
  expect((await listTrash(library)).entries).toEqual([]);
  expect(readdirSync(join(root, "covers"))).toEqual([]);
});
