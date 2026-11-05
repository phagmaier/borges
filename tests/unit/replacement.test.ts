import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  archiveBook,
  editMetadata,
  markFinished,
} from "../../src/library/books";
import { addFileAsNewBook, replaceBookFile } from "../../src/library/import";
import { beginReaderSession, saveProgress } from "../../src/library/progress";
import { getBook } from "../../src/library/query";
import { reconcileOperations } from "../../src/library/recovery";
import { addBooksToSection, createSection } from "../../src/library/sections";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { kill, killChildren, startChild } from "./library-fixtures";

let temporary: string;
let library: Library;
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "borges-replace-"));
  library = openLibrary({ root: join(temporary, "library") });
});
afterEach(() => {
  killChildren();
  library.close();
  rmSync(temporary, { recursive: true, force: true });
});
const pdf = "tests/fixtures/known.pdf";
const epub = "tests/fixtures/reflowable.epub";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=",
  "base64",
);
const extracted = () => ({
  title: "Fresh title",
  authors: ["Zora", "Ana"],
  subjects: ["Gardens"],
  cover: png,
  warnings: [],
});

it.each(["changed-bytes", "referenced-path"])(
  "retains uncertain replacement artifacts (%s) without touching the live revision",
  async (mode) => {
    const { added } = await seed();
    await expect(
      replaceBookFile(library, added.bookId, epub, {
        checkpoint(step) {
          if (step !== "published") return;
          const op = library.database
            .prepare(
              "SELECT id, published_path FROM recovery_operations WHERE kind = 'replace' AND state = 'published'",
            )
            .get();
          if (mode === "changed-bytes")
            writeFileSync(
              join(library.root, String(op?.published_path)),
              "uncertain bytes",
            );
          else
            library.database
              .prepare(
                "UPDATE recovery_operations SET published_path = ? WHERE id = ?",
              )
              .run(added.path, String(op?.id));
          throw new Error("interrupted");
        },
      }),
    ).rejects.toMatchObject({ code: "storage-failed" });
    const report = await reconcileOperations(library);
    expect(report.operations).toMatchObject([
      { kind: "replace", outcome: "retained" },
    ]);
    expect(readFileSync(join(library.root, added.path))).toEqual(
      readFileSync(pdf),
    );
    expect(getBook(library.database, added.bookId).format).toBe("pdf");
    expect(
      library.database.prepare("SELECT * FROM trash_entries").all(),
    ).toEqual([]);
    expect(readdirSync(join(library.root, "files"))).toHaveLength(2);
  },
);
async function seed() {
  const added = await addFileAsNewBook(library, pdf);
  const grant = beginReaderSession(library.database, added.bookId);
  saveProgress(library.database, {
    ...grant,
    sequence: 1,
    location: { format: "pdf", page: 3, x: 0, y: 0.5 },
    sizing: { fontSize: 22, zoom: 1.5 },
  });
  return { added, grant };
}

it("replaces across formats, preserving identity/organization/manual clears and retiring old bytes/location atomically", async () => {
  const { database } = library;
  const { added, grant } = await seed();
  const section = createSection(database, { name: "Shelf" });
  addBooksToSection(database, section.id, [added.bookId]);
  markFinished(database, added.bookId);
  archiveBook(database, added.bookId);
  editMetadata(database, added.bookId, { title: "My title", authors: [] });
  const replacement = await replaceBookFile(library, added.bookId, epub, {
    inspect: async () => extracted(),
    now: () => 5000,
  });
  expect(replacement.bookId).toBe(added.bookId);
  expect(replacement.revisionId).not.toBe(added.revisionId);
  expect(getBook(database, added.bookId)).toMatchObject({
    title: "My title",
    authors: [],
    subjects: ["Gardens"],
    status: "finished",
    archived: true,
    format: "epub",
  });
  expect(
    database
      .prepare("SELECT section_id FROM section_memberships WHERE book_id = ?")
      .all(added.bookId),
  ).toEqual([{ section_id: section.id }]);
  expect(
    database
      .prepare(
        "SELECT kind, book_id, revision_id, trashed_at FROM trash_entries",
      )
      .get(),
  ).toEqual({
    kind: "revision",
    book_id: added.bookId,
    revision_id: added.revisionId,
    trashed_at: 5000,
  });
  expect(
    database
      .prepare("SELECT retired_at FROM revisions WHERE id = ?")
      .get(added.revisionId),
  ).toEqual({ retired_at: 5000 });
  expect(
    database
      .prepare("SELECT pdf_page, pan_y FROM positions WHERE revision_id = ?")
      .get(added.revisionId),
  ).toEqual({ pdf_page: 3, pan_y: 0.5 });
  expect(
    database
      .prepare(
        "SELECT extracted_title, extracted_authors FROM revisions WHERE id = ?",
      )
      .get(replacement.revisionId),
  ).toEqual({
    extracted_title: "Fresh title",
    extracted_authors: '["Zora","Ana"]',
  });
  expect(beginReaderSession(database, added.bookId)).toMatchObject({
    location: null,
    sizing: { fontSize: null, zoom: 1.5 },
  });
  expect(() =>
    saveProgress(database, {
      ...grant,
      sequence: 2,
      location: { format: "pdf", page: 2, x: 0, y: 0 },
      sizing: { fontSize: 22, zoom: 1 },
    }),
  ).toThrow(/no longer current/);
  expect(readFileSync(join(library.root, added.path))).toEqual(
    readFileSync(pdf),
  );
  expect(readFileSync(join(library.root, replacement.path))).toEqual(
    readFileSync(epub),
  );
  expect(await reconcileOperations(library)).toEqual({
    operations: [],
    unrecognized: [],
  });
});

it("refreshes only available nonmanual fields, keeps manual covers and compatible sizing", async () => {
  const { database } = library;
  const added = await addFileAsNewBook(library, epub, {
    inspect: async () => extracted(),
  });
  const oldCover = getBook(database, added.bookId).coverToken;
  const grant = beginReaderSession(database, added.bookId);
  saveProgress(database, {
    ...grant,
    sequence: 1,
    location: {
      format: "epub",
      cfi: "epubcfi(/6/2!/4/2)",
      section: 0,
      fraction: 0.5,
      x: 0,
      y: 0,
    },
    sizing: { fontSize: 24, zoom: 2 },
  });
  // Mark this already-published raster as the user's chosen cover.
  database
    .prepare("UPDATE books SET cover_manual = 1 WHERE id = ?")
    .run(added.bookId);
  const replaced = await replaceBookFile(
    library,
    added.bookId,
    "tests/fixtures/fixed.epub",
    {
      inspect: async () => ({
        ...extracted(),
        title: "New title",
        authors: [],
        subjects: [],
        cover: null,
      }),
    },
  );
  expect(getBook(database, added.bookId)).toMatchObject({
    title: "New title",
    authors: ["Zora", "Ana"],
    subjects: ["Gardens"],
    coverToken: oldCover,
  });
  expect(beginReaderSession(database, added.bookId)).toMatchObject({
    location: null,
    sizing: { fontSize: 24, zoom: 2 },
  });
  expect(
    database
      .prepare(
        "SELECT extracted_authors, extracted_cover_path FROM revisions WHERE id = ?",
      )
      .get(replaced.revisionId),
  ).toEqual({ extracted_authors: "[]", extracted_cover_path: null });
  // Missing replacement title keeps a useful old title, not the new filename.
  await replaceBookFile(library, added.bookId, "tests/fixtures/image-only.pdf");
  expect(getBook(database, added.bookId).title).toBe("New title");
  expect(beginReaderSession(database, added.bookId)).toMatchObject({
    location: null,
    sizing: { fontSize: null, zoom: 2 },
  });
});

it.each(["validated", "staged", "renamed", "published", "committing"] as const)(
  "rolls back replacement failures at %s while preserving the old book and position",
  async (step) => {
    const { added } = await seed();
    const before = getBook(library.database, added.bookId);
    await expect(
      replaceBookFile(library, added.bookId, epub, {
        inspect: async () => extracted(),
        checkpoint(reached) {
          if (reached === step) throw new Error("disk full");
        },
      }),
    ).rejects.toMatchObject({ code: "storage-failed" });
    expect(getBook(library.database, added.bookId)).toEqual(before);
    expect(
      beginReaderSession(library.database, added.bookId).location,
    ).toMatchObject({ page: 3 });
    expect(
      library.database.prepare("SELECT * FROM trash_entries").all(),
    ).toEqual([]);
    expect(readdirSync(join(library.root, "files"))).toEqual([
      added.path.slice(6),
    ]);
    expect(readdirSync(join(library.root, "covers"))).toEqual([]);
    expect(readdirSync(join(library.root, "staging"))).toEqual([]);
    expect(await reconcileOperations(library)).toEqual({
      operations: [],
      unrecognized: [],
    });
  },
);

it("cancellation, a failed reader save, and a changed target all prevent the switch", async () => {
  const { added } = await seed();
  const before = getBook(library.database, added.bookId);
  const controller = new AbortController();
  await expect(
    replaceBookFile(library, added.bookId, epub, {
      signal: controller.signal,
      checkpoint(step) {
        if (step === "published") controller.abort();
      },
    }),
  ).rejects.toMatchObject({ code: "cancelled" });
  await expect(
    replaceBookFile(library, added.bookId, epub, {
      beforeCommit() {
        throw new Error("reader save failed");
      },
    }),
  ).rejects.toThrow(/reader save failed.*previous revision remains current/);
  await expect(
    replaceBookFile(library, added.bookId, epub, {
      expectedRevisionId: "an-earlier-revision",
    }),
  ).rejects.toThrow(/file changed/);
  // A concurrent file change during validation must fail the commit-time precondition too.
  let once = false;
  await expect(
    replaceBookFile(library, added.bookId, epub, {
      async inspect() {
        if (!once) {
          once = true;
          await replaceBookFile(
            library,
            added.bookId,
            "tests/fixtures/image-only.pdf",
          );
        }
        return extracted();
      },
    }),
  ).rejects.toThrow(/file changed/);
  expect(getBook(library.database, added.bookId)).toMatchObject({
    title: before.title,
    format: "pdf",
  });
  expect(
    library.database.prepare("SELECT count(*) AS n FROM trash_entries").get(),
  ).toEqual({ n: 1 });
  expect(readdirSync(join(library.root, "staging"))).toEqual([]);
  expect(await reconcileOperations(library)).toEqual({
    operations: [],
    unrecognized: [],
  });
});

it("refuses bytes already live in another book, including archived books", async () => {
  const { added } = await seed();
  const other = await addFileAsNewBook(library, epub);
  archiveBook(library.database, other.bookId);
  await expect(
    replaceBookFile(library, added.bookId, epub),
  ).rejects.toMatchObject({
    code: "duplicate",
    existing: { bookId: other.bookId },
  });
  expect(
    library.database
      .prepare("SELECT current_revision_id FROM books WHERE id = ?")
      .get(added.bookId),
  ).toEqual({ current_revision_id: added.revisionId });
  expect(library.database.prepare("SELECT * FROM trash_entries").all()).toEqual(
    [],
  );
});

it.each([false, true])(
  "explicitly replaces its own identical content (managed copy missing: %s)",
  async (missing) => {
    const { added } = await seed();
    if (missing) rmSync(join(library.root, added.path));
    const next = await replaceBookFile(library, added.bookId, pdf);
    expect(next.revisionId).not.toBe(added.revisionId);
    expect(readFileSync(join(library.root, next.path))).toEqual(
      readFileSync(pdf),
    );
    expect(
      beginReaderSession(library.database, added.bookId).location,
    ).toBeNull();
    expect(
      library.database.prepare("SELECT revision_id FROM trash_entries").get(),
    ).toEqual({ revision_id: added.revisionId });
    expect(
      library.database
        .prepare("SELECT pdf_page FROM positions WHERE revision_id = ?")
        .get(added.revisionId),
    ).toEqual({ pdf_page: 3 });
  },
);

it.each([
  "pending",
  "copying",
  "cover-pending",
  "cover-renamed",
  "published",
  "committing",
  "committed",
] as const)(
  "reconciles a real process killed at replacement %s",
  async (step) => {
    const { added } = await seed();
    const root = library.root;
    library.close();
    const child = await startChild(
      "replace-and-stop",
      root,
      `at ${step}`,
      epub,
      step,
      added.bookId,
    );
    await kill(child);
    library = openLibrary({ root });
    const report = await reconcileOperations(library);
    expect(report.unrecognized).toEqual([]);
    expect(readFileSync(join(root, added.path))).toEqual(readFileSync(pdf));
    expect(
      library.database
        .prepare("SELECT pdf_page FROM positions WHERE revision_id = ?")
        .get(added.revisionId),
    ).toEqual({ pdf_page: 3 });
    expect(readdirSync(join(root, "staging"))).toEqual([]);
    if (step === "committed") {
      expect(report.operations).toEqual([]);
      expect(getBook(library.database, added.bookId)).toMatchObject({
        title: "Fresh title",
        format: "epub",
      });
      expect(
        beginReaderSession(library.database, added.bookId).location,
      ).toBeNull();
      expect(
        library.database.prepare("SELECT revision_id FROM trash_entries").get(),
      ).toEqual({ revision_id: added.revisionId });
      expect(readdirSync(join(root, "files"))).toHaveLength(2);
      expect(readdirSync(join(root, "covers"))).toHaveLength(1);
    } else {
      expect(
        report.operations.every((op) => op.outcome === "rolled-back"),
      ).toBe(true);
      expect(getBook(library.database, added.bookId)).toMatchObject({
        title: "known",
        format: "pdf",
      });
      expect(
        library.database.prepare("SELECT * FROM trash_entries").all(),
      ).toEqual([]);
      expect(readdirSync(join(root, "files"))).toHaveLength(1);
      expect(readdirSync(join(root, "covers"))).toEqual([]);
    }
    expect(await reconcileOperations(library)).toEqual({
      operations: [],
      unrecognized: [],
    });
  },
);

it.each(["prompt", "cover-pending", "committed"])(
  "reconciles import killed at metadata choice/replacement %s",
  async (step) => {
    const { added } = await seed();
    editMetadata(library.database, added.bookId, {
      title: "Fresh title",
      authors: ["Ana"],
    });
    const root = library.root;
    library.close();
    const child = await startChild(
      "duplicate-and-stop",
      root,
      `at ${step}`,
      epub,
      step,
      added.bookId,
    );
    await kill(child);
    library = openLibrary({ root });
    const report = await reconcileOperations(library);
    expect(report.unrecognized).toEqual([]);
    expect(readFileSync(join(root, added.path))).toEqual(readFileSync(pdf));
    expect(readdirSync(join(root, "staging"))).toEqual([]);
    const trash = library.database
      .prepare("SELECT revision_id FROM trash_entries")
      .all();
    if (step === "committed") {
      expect(getBook(library.database, added.bookId).format).toBe("epub");
      expect(trash).toEqual([{ revision_id: added.revisionId }]);
      expect(readdirSync(join(root, "files"))).toHaveLength(2);
    } else {
      expect(getBook(library.database, added.bookId).format).toBe("pdf");
      expect(trash).toEqual([]);
      expect(readdirSync(join(root, "files"))).toHaveLength(1);
      expect(readdirSync(join(root, "covers"))).toEqual([]);
    }
  },
);

it("cancels replacement if its reader drain is interrupted before the catalog commit", async () => {
  const { added } = await seed();
  const controller = new AbortController();
  await expect(
    replaceBookFile(library, added.bookId, epub, {
      signal: controller.signal,
      async beforeCommit() {
        await Promise.resolve();
        controller.abort();
      },
    }),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(
    library.database
      .prepare("SELECT current_revision_id FROM books WHERE id = ?")
      .get(added.bookId)?.current_revision_id,
  ).toBe(added.revisionId);
  expect(
    library.database.prepare("SELECT count(*) AS n FROM trash_entries").get()
      ?.n,
  ).toBe(0);
  expect((await reconcileOperations(library)).unrecognized).toEqual([]);
});
