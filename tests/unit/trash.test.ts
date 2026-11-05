import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  archiveBook,
  editMetadata,
  markFinished,
} from "../../src/library/books";
import { addFileAsNewBook } from "../../src/library/import";
import { beginReaderSession, saveProgress } from "../../src/library/progress";
import { queryBooks } from "../../src/library/query";
import { restoreRevision } from "../../src/library/revision-restore";
import {
  addBooksToSection,
  createSection,
  deleteSection,
} from "../../src/library/sections";
import {
  deleteBook,
  listTrash,
  restoreDeletedBook,
} from "../../src/library/trash";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { kill, killChildren, startChild } from "./library-fixtures";

let root: string;
let library: Library;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "borges-trash-"));
  library = openLibrary({ root });
});
afterEach(() => {
  killChildren();
  library.close();
  rmSync(root, { recursive: true, force: true });
});
const source = "tests/fixtures/known.pdf";

it("deletes atomically without touching bytes and restores status, manual metadata, position and surviving memberships", async () => {
  const book = await addFileAsNewBook(library, source);
  editMetadata(library.database, book.bookId, {
    title: "My Atlas",
    authors: ["Ana"],
  });
  markFinished(library.database, book.bookId);
  archiveBook(library.database, book.bookId);
  const kept = createSection(library.database, {
    name: "Kept",
    parentId: null,
  });
  const removed = createSection(library.database, {
    name: "Gone",
    parentId: null,
  });
  addBooksToSection(library.database, kept.id, [book.bookId]);
  addBooksToSection(library.database, removed.id, [book.bookId]);
  const grant = beginReaderSession(library.database, book.bookId);
  const write = {
    bookId: book.bookId,
    revisionId: book.revisionId,
    generation: grant.generation,
    sequence: 1,
    location: { format: "pdf" as const, page: 3, x: 0, y: 0.5 },
    sizing: { fontSize: 18, zoom: 1.5 },
  };
  saveProgress(library.database, write);
  const entry = deleteBook(library.database, book.bookId);
  expect(
    queryBooks(library.database, {
      view: { kind: "all" },
      includeArchived: true,
    }),
  ).toEqual([]);
  expect(() =>
    saveProgress(library.database, { ...write, sequence: 2 }),
  ).toThrow();
  expect(readFileSync(join(root, book.path))).toEqual(readFileSync(source));
  expect(readdirSync(join(root, "files"))).toHaveLength(1);
  const trash = await listTrash(library);
  expect(trash.entries).toMatchObject([
    {
      id: entry.id,
      kind: "book",
      title: "My Atlas",
      status: "finished",
      archived: true,
      position: "Page 3",
    },
  ]);
  expect(trash.bytes).toBe(readFileSync(source).length);
  deleteSection(library.database, removed.id);
  const result = await restoreDeletedBook(library, entry.id);
  expect(result.missingSections).toEqual(["Gone"]);
  expect(result.bookId).toBe(book.bookId);
  expect(
    library.database
      .prepare("SELECT section_id FROM section_memberships WHERE book_id = ?")
      .all(book.bookId),
  ).toEqual([{ section_id: kept.id }]);
  expect(() =>
    saveProgress(library.database, { ...write, sequence: 2 }),
  ).toThrow();
  expect(beginReaderSession(library.database, book.bookId)).toMatchObject({
    location: { format: "pdf", page: 3, y: 0.5 },
    sizing: { zoom: 1.5 },
  });
  expect(
    queryBooks(library.database, { view: { kind: "archive" } }),
  ).toMatchObject([
    { title: "My Atlas", status: "finished", authors: ["Ana"] },
  ]);
  expect((await listTrash(library)).entries).toEqual([]);
});

it("rolls back failed delete and restore transactions without losing Trash context", async () => {
  const book = await addFileAsNewBook(library, source);
  library.database.exec(
    "CREATE TRIGGER refuse_delete BEFORE UPDATE OF deleted_at ON books BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
  expect(() => deleteBook(library.database, book.bookId)).toThrow("disk full");
  expect((await listTrash(library)).entries).toEqual([]);
  expect(queryBooks(library.database, { view: { kind: "all" } })).toHaveLength(
    1,
  );
  library.database.exec("DROP TRIGGER refuse_delete");
  const entry = deleteBook(library.database, book.bookId);
  library.database.exec(
    "CREATE TRIGGER refuse_restore BEFORE DELETE ON trash_entries BEGIN SELECT RAISE(ABORT, 'restore failed'); END",
  );
  await expect(restoreDeletedBook(library, entry.id)).rejects.toThrow(
    "restore failed",
  );
  expect(queryBooks(library.database, { view: { kind: "all" } })).toEqual([]);
  expect((await listTrash(library)).entries).toHaveLength(1);
});

it("refuses a deleted-book restore when the same content became live, including Archive", async () => {
  const book = await addFileAsNewBook(library, source);
  const entry = deleteBook(library.database, book.bookId);
  const duplicate = await restoreRevision(library, entry.id, "separate");
  archiveBook(library.database, duplicate.bookId);
  await expect(restoreDeletedBook(library, entry.id)).rejects.toMatchObject({
    bookId: duplicate.bookId,
  });
  expect((await listTrash(library)).entries).toHaveLength(1);
});

it("restores to Unfiled without recreating deleted sections and rejects replayed restores", async () => {
  const book = await addFileAsNewBook(library, source);
  const section = createSection(library.database, {
    name: "Gone",
    parentId: null,
  });
  addBooksToSection(library.database, section.id, [book.bookId]);
  const entry = deleteBook(library.database, book.bookId);
  deleteSection(library.database, section.id);
  expect(await restoreDeletedBook(library, entry.id)).toMatchObject({
    missingSections: ["Gone"],
    unfiled: true,
  });
  expect(library.database.prepare("SELECT * FROM sections").all()).toEqual([]);
  await expect(restoreDeletedBook(library, entry.id)).rejects.toThrow(
    "no longer in Trash",
  );
});

it("keeps missing-file catalog entries and explains how to repair a restored entry", async () => {
  const book = await addFileAsNewBook(library, source);
  const entry = deleteBook(library.database, book.bookId);
  rmSync(join(root, book.path));
  expect(await listTrash(library)).toMatchObject({
    bytes: 0,
    unavailableFiles: 1,
    entries: [{ fileProblem: true }],
  });
  const restored = await restoreDeletedBook(library, entry.id);
  expect(restored.warnings.join(" ")).toContain("Replace File");
  expect(queryBooks(library.database, { view: { kind: "all" } })).toHaveLength(
    1,
  );
});

it("lists superseded revisions separately, preserves their positions and counts shared covers once", async () => {
  const { replaceBookFile } = await import("../../src/library/import");
  const book = await addFileAsNewBook(library, source);
  const grant = beginReaderSession(library.database, book.bookId);
  saveProgress(library.database, {
    ...grant,
    sequence: 1,
    location: { format: "pdf", page: 2, x: 0, y: 0 },
    sizing: { zoom: 2, fontSize: 18 },
  });
  const cover = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=",
    "base64",
  );
  const epub = "tests/fixtures/reflowable.epub";
  await replaceBookFile(library, book.bookId, epub, {
    inspect: async () => ({
      title: "New edition",
      authors: [],
      subjects: [],
      cover,
      warnings: [],
    }),
  });
  deleteBook(library.database, book.bookId);
  const trash = await listTrash(library);
  expect(trash.entries).toHaveLength(2);
  expect(trash.entries.find((e) => e.kind === "revision")).toMatchObject({
    revisionId: book.revisionId,
    position: "Page 2",
    format: "pdf",
  });
  expect(trash.bytes).toBe(
    readFileSync(source).length + readFileSync(epub).length + cover.length,
  );
  await expect(
    restoreDeletedBook(
      library,
      trash.entries.find((e) => e.kind === "revision")?.id,
    ),
  ).rejects.toThrow("no longer in Trash");
});

it("rejects invalid IDs, repeated deletion and damaged restore context without changing catalog state", async () => {
  expect(() => deleteBook(library.database, null)).toThrow();
  const book = await addFileAsNewBook(library, source);
  const entry = deleteBook(library.database, book.bookId);
  expect(() => deleteBook(library.database, book.bookId)).toThrow();
  library.database
    .prepare("UPDATE trash_entries SET context = '{}' WHERE id = ?")
    .run(entry.id);
  await expect(restoreDeletedBook(library, entry.id)).rejects.toThrow(
    "context is damaged",
  );
  expect((await listTrash(library)).entries).toHaveLength(1);
});

it.each([
  "delete-committing",
  "delete-committed",
  "restore-committing",
  "restore-committed",
])(
  "recovers catalog-only Trash action after SIGKILL at %s",
  async (scenario) => {
    const book = await addFileAsNewBook(library, source);
    const restoring = scenario.startsWith("restore");
    const entry = restoring
      ? deleteBook(library.database, book.bookId).id
      : book.bookId;
    const step = scenario.endsWith("-committed") ? "committed" : "committing";
    library.close();
    const child = await startChild(
      "trash-and-stop",
      root,
      `at ${step}`,
      restoring ? "restore" : "delete",
      entry,
      step,
    );
    await kill(child);
    library = openLibrary({ root });
    const deleted = restoring ? step !== "committed" : step === "committed";
    expect(
      queryBooks(library.database, { view: { kind: "all" } }),
    ).toHaveLength(deleted ? 0 : 1);
    expect((await listTrash(library)).entries).toHaveLength(deleted ? 1 : 0);
    expect(readFileSync(join(root, book.path))).toEqual(readFileSync(source));
    expect(readdirSync(join(root, "files"))).toHaveLength(1);
  },
);
