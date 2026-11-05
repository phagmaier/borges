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
import { InspectionError } from "../../src/library/extraction";
import { addFileAsNewBook } from "../../src/library/import";
import { importBatch } from "../../src/library/import-batch";
import { getBook } from "../../src/library/query";
import { reconcileOperations } from "../../src/library/recovery";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { kill, killChildren, startChild } from "./library-fixtures";

let temporary: string;
let library: Library;
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "borges-extraction-"));
  library = openLibrary({ root: join(temporary, "library") });
});
afterEach(() => {
  killChildren();
  library.close();
  rmSync(temporary, { recursive: true, force: true });
});
const source = "tests/fixtures/known.pdf";

it("commits extracted and effective metadata together, preserving author order and subject spelling", async () => {
  const added = await addFileAsNewBook(library, source, {
    inspect: async () => ({
      title: "  A Garden  ",
      authors: [" Zora ", "Ana"],
      subjects: [" Gardens ", "GARDENS", "Fiction"],
      warnings: [],
      cover: null,
    }),
  });
  expect(getBook(library.database, added.bookId)).toMatchObject({
    title: "A Garden",
    authors: ["Zora", "Ana"],
    subjects: ["Fiction", "Gardens"],
  });
  expect(
    library.database
      .prepare(
        "SELECT extracted_title, extracted_authors, extracted_subjects, extracted_cover_path FROM revisions",
      )
      .get(),
  ).toEqual({
    extracted_title: "A Garden",
    extracted_authors: '["Zora","Ana"]',
    extracted_subjects: '["Gardens","Fiction"]',
    extracted_cover_path: null,
  });
  expect(
    library.database
      .prepare(
        "SELECT title_manual, authors_manual, subjects_manual, cover_manual FROM books",
      )
      .get(),
  ).toEqual({
    title_manual: 0,
    authors_manual: 0,
    subjects_manual: 0,
    cover_manual: 0,
  });
  expect(added.warnings).toEqual([]);
});

it("shows extraction warnings in the batch outcome and uses the filename when title is absent", async () => {
  const result = await importBatch(library, [join(process.cwd(), source)], {
    inspect: async () => ({
      title: null,
      authors: [],
      subjects: [],
      warnings: ["Cover could not be extracted."],
      cover: null,
    }),
  });
  expect(result.outcomes[0]).toMatchObject({
    kind: "imported",
    message: "Imported as “known”. Warning: Cover could not be extracted.",
  });
  expect(library.database.prepare("SELECT title FROM books").get()).toEqual({
    title: "known",
  });
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=",
  "base64",
);
const extracted = () => ({
  title: "Extracted atlas",
  authors: ["Ana"],
  subjects: [],
  warnings: [],
  cover: png,
});

it("rolls back validation failures and commits no entry or partial files", async () => {
  await expect(
    addFileAsNewBook(library, source, {
      inspect: async () => {
        throw new InspectionError(
          "protected",
          "Encrypted PDFs are not supported.",
        );
      },
    }),
  ).rejects.toMatchObject({ code: "protected" });
  expect(library.database.prepare("SELECT id FROM books").all()).toEqual([]);
  expect(readdirSync(join(library.root, "staging"))).toEqual([]);
  expect(readdirSync(join(library.root, "files"))).toEqual([]);
});

it("rolls back both book and extracted cover when the catalog transaction fails", async () => {
  await expect(
    addFileAsNewBook(library, source, {
      inspect: async () => extracted(),
      checkpoint(step) {
        if (step === "committing") throw new Error("disk full");
      },
    }),
  ).rejects.toMatchObject({ code: "storage-failed" });
  expect(library.database.prepare("SELECT id FROM books").all()).toEqual([]);
  for (const dir of ["staging", "files", "covers"])
    expect(readdirSync(join(library.root, dir))).toEqual([]);
  expect(await reconcileOperations(library)).toEqual({
    operations: [],
    unrecognized: [],
  });
});

it("treats cover publication failure as a warning and still imports usable metadata and bytes", async () => {
  const added = await addFileAsNewBook(library, source, {
    inspect: async () => extracted(),
    checkpoint(step) {
      if (step === "cover-renamed") throw new Error("disk full");
    },
  });
  expect(added).toMatchObject({
    title: "Extracted atlas",
    warnings: ["Cover could not be stored; a placeholder will be used."],
  });
  expect(
    library.database.prepare("SELECT cover_path FROM books").get(),
  ).toEqual({ cover_path: null });
  expect(readdirSync(join(library.root, "covers"))).toEqual([]);
  expect(await reconcileOperations(library)).toEqual({
    operations: [],
    unrecognized: [],
  });
});

it("cancels after cover publication without creating a book or orphan cover", async () => {
  const controller = new AbortController();
  await expect(
    addFileAsNewBook(library, source, {
      inspect: async () => extracted(),
      signal: controller.signal,
      checkpoint(step) {
        if (step === "cover-published") controller.abort();
      },
    }),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(library.database.prepare("SELECT id FROM books").all()).toEqual([]);
  for (const dir of ["staging", "files", "covers"])
    expect(readdirSync(join(library.root, dir))).toEqual([]);
});

it.each([
  "cover-pending",
  "cover-staged",
  "cover-renamed",
  "cover-published",
  "published",
  "committing",
  "committed",
] as const)(
  "reconciles a process killed at %s with extracted cover publication",
  async (step) => {
    const root = library.root;
    const sourceBytes = readFileSync(source);
    const cover = join(temporary, "cover.png");
    writeFileSync(cover, png);
    library.close();
    const child = await startChild(
      "import-extracted-and-stop",
      root,
      `at ${step}`,
      source,
      step,
      cover,
    );
    await kill(child);
    library = openLibrary({ root });
    const report = await reconcileOperations(library);
    expect(report.unrecognized).toEqual([]);
    if (step === "committed") {
      expect(report.operations).toEqual([]);
      const row = library.database
        .prepare(
          "SELECT b.title, b.cover_path, r.extracted_cover_path FROM books b JOIN revisions r ON r.id = b.current_revision_id",
        )
        .get();
      expect(row).toMatchObject({
        title: "Extracted atlas",
        cover_path: expect.stringMatching(/^covers\//),
      });
      expect(row?.extracted_cover_path).toBe(row?.cover_path);
      expect(readFileSync(join(root, String(row?.cover_path)))).toEqual(png);
      expect(readdirSync(join(root, "files"))).toHaveLength(1);
    } else {
      expect(report.operations).toHaveLength(2);
      expect(
        report.operations.every((op) => op.outcome === "rolled-back"),
      ).toBe(true);
      expect(library.database.prepare("SELECT id FROM books").all()).toEqual(
        [],
      );
      for (const dir of ["staging", "files", "covers"])
        expect(readdirSync(join(root, dir))).toEqual([]);
    }
    expect(readFileSync(source)).toEqual(sourceBytes);
  },
);
