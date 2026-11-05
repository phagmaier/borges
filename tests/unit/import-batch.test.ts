import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveBook } from "../../src/library/books";
import { addFileAsNewBook } from "../../src/library/import";
import {
  type ImportProgress,
  type ImportSummary,
  importBatch,
} from "../../src/library/import-batch";
import { createSection, deleteSection } from "../../src/library/sections";
import { type Library, openLibrary } from "../../src/storage/catalog";

let temporary: string;
let root: string;
let sources: string;
let library: Library;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "borges-batch-"));
  root = join(temporary, "library");
  sources = join(temporary, "sources");
  mkdirSync(sources);
  library = openLibrary({ root });
});
afterEach(() => {
  library.close();
  rmSync(temporary, { recursive: true, force: true });
});

const fixture = (name: string) => readFileSync(join("tests/fixtures", name));
function put(relative: string, bytes: Buffer | string): string {
  const path = join(sources, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}
const rows = (sql: string, ...args: string[]) =>
  library.database
    .prepare(sql)
    .all(...args)
    .map((row) => ({ ...row }));
const managed = (directory: string) => readdirSync(join(root, directory));
const brief = (summary: ImportSummary) =>
  summary.outcomes.map(({ name, kind }) => ({ name, kind }));
const titles = () =>
  rows("SELECT title FROM books ORDER BY title").map((row) => row.title);

/** sha256 of every regular file below a directory, keyed by relative path. */
function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    result[path] = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
  }
  return result;
}

describe("batch import", () => {
  it("walks a mixed folder: recurses, skips linked folders, reads file links, and reports every file", async () => {
    put("Shelf/Atlas.pdf", fixture("known.pdf"));
    put("Shelf/notes.txt", "Shopping list\n");
    put("Shelf/Fake.pdf", "This is plain text.\n");
    const epub = fixture("reflowable.epub");
    put("Shelf/Broken.epub", epub.subarray(0, epub.length / 2));
    put("Shelf/Nested/Story.epub", epub);
    put("Shelf/Nested/Deeper/Scan.PDF", fixture("image-only.pdf"));
    put("Elsewhere/Hidden.pdf", fixture("known.pdf").subarray(0, 400));
    put("Elsewhere/Fixed.epub", fixture("fixed.epub"));
    symlinkSync(
      join(sources, "Elsewhere"),
      join(sources, "Shelf/Linked folder"),
    );
    symlinkSync(
      join(sources, "Elsewhere/Fixed.epub"),
      join(sources, "Shelf/Linked book.epub"),
    );
    execFileSync("mkfifo", [join(sources, "Shelf/pipe.pdf")]);
    const before = snapshot(sources);
    const progress: ImportProgress[] = [];
    const imported: string[] = [];

    const summary = await importBatch(library, [join(sources, "Shelf")], {
      onProgress: (update) => progress.push(update),
      onImported: (bookId) => imported.push(bookId),
    });

    expect(brief(summary)).toEqual([
      { name: "Shelf/Atlas.pdf", kind: "imported" },
      { name: "Shelf/Broken.epub", kind: "unsupported" },
      { name: "Shelf/Fake.pdf", kind: "unsupported" },
      { name: "Shelf/Linked book.epub", kind: "imported" },
      { name: "Shelf/Linked folder", kind: "skipped" },
      { name: "Shelf/notes.txt", kind: "unsupported" },
      { name: "Shelf/pipe.pdf", kind: "unsupported" },
      { name: "Shelf/Nested/Story.epub", kind: "imported" },
      { name: "Shelf/Nested/Deeper/Scan.PDF", kind: "imported" },
    ]);
    expect(summary.cancelled).toBe(false);
    const message = (name: string) =>
      summary.outcomes.find((outcome) => outcome.name === name)?.message;
    expect(message("Shelf/Fake.pdf")).toBe(
      "Fake.pdf does not contain PDF data.",
    );
    expect(message("Shelf/notes.txt")).toBe(
      "Shelf/notes.txt is not a PDF or EPUB file.",
    );
    expect(message("Shelf/pipe.pdf")).toBe(
      "Shelf/pipe.pdf is not a regular file.",
    );
    expect(message("Shelf/Linked folder")).toMatch(/not followed/);
    // Titles fall back to file names; everything is Unread and Unfiled.
    expect(titles()).toEqual(["Atlas", "Linked book", "Scan", "Story"]);
    expect(
      rows("SELECT DISTINCT reading_status, archived_at FROM books"),
    ).toEqual([{ reading_status: "unread", archived_at: null }]);
    expect(rows("SELECT * FROM section_memberships")).toEqual([]);
    expect(imported).toHaveLength(4);
    expect(managed("files")).toHaveLength(4);
    expect(managed("staging")).toEqual([]);
    // Only content checks reached the operation protocol; both rolled back.
    expect(
      rows(
        "SELECT state, count(*) AS n FROM recovery_operations GROUP BY state ORDER BY state",
      ),
    ).toEqual([
      { state: "abandoned", n: 2 },
      { state: "committed", n: 4 },
    ]);
    expect(progress.map((update) => update.current)).toEqual([
      "Shelf/Atlas.pdf",
      "Shelf/Broken.epub",
      "Shelf/Fake.pdf",
      "Shelf/Linked book.epub",
      "Shelf/Nested/Story.epub",
      "Shelf/Nested/Deeper/Scan.PDF",
      null,
    ]);
    expect(progress.at(-1)).toEqual({ completed: 6, total: 6, current: null });
    expect(snapshot(sources)).toEqual(before);
  });

  it("skips byte-identical live content, archived included, within and across batches", async () => {
    const atlas = put("Atlas.pdf", fixture("known.pdf"));
    const first = await importBatch(library, [atlas]);
    const atlasId = first.outcomes[0]?.bookId as string;
    archiveBook(library.database, atlasId);
    const story = fixture("reflowable.epub");
    const steps: string[] = [];

    const second = await importBatch(
      library,
      [
        put("Atlas copy.pdf", fixture("known.pdf")),
        put("Story.epub", story),
        put("Story again.epub", story),
      ],
      {
        checkpoint: (name, step) => {
          if (name === "Atlas copy.pdf") steps.push(step);
        },
      },
    );
    // Recognized from the staged copy; it is never published.
    expect(steps).toEqual(["pending", "copying"]);

    const storyId = second.outcomes[1]?.bookId as string;
    expect(second.outcomes).toEqual([
      {
        name: "Atlas copy.pdf",
        kind: "skipped",
        message:
          "Atlas copy.pdf is already in the library as “Atlas” (archived); it was skipped.",
        existing: { bookId: atlasId, title: "Atlas", archived: true },
      },
      {
        name: "Story.epub",
        kind: "imported",
        message: "Imported as “Story”.",
        bookId: storyId,
      },
      {
        name: "Story again.epub",
        kind: "skipped",
        message:
          "Story again.epub is already in the library as “Story”; it was skipped.",
        existing: { bookId: storyId, title: "Story", archived: false },
      },
    ]);
    expect(titles()).toEqual(["Atlas", "Story"]);
    expect(managed("files")).toHaveLength(2);
    expect(managed("staging")).toEqual([]);
  });

  it("lets only one of two concurrent identical imports commit", async () => {
    const a = put("One.pdf", fixture("known.pdf"));
    const b = put("Two.pdf", fixture("known.pdf"));
    const results = await Promise.allSettled([
      addFileAsNewBook(library, a),
      addFileAsNewBook(library, b),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "duplicate" });
    expect(rows("SELECT id FROM books")).toHaveLength(1);
    expect(managed("files")).toHaveLength(1);
    expect(managed("staging")).toEqual([]);
  });

  it("joins the selected section in the same commit, and falls back to Unfiled if it is deleted meanwhile", async () => {
    const { id: sectionId } = createSection(library.database, {
      name: "Atlases",
    });
    const joined = await importBatch(
      library,
      [put("Atlas.pdf", fixture("known.pdf"))],
      { sectionId },
    );
    expect(
      rows(
        "SELECT section_id FROM section_memberships WHERE book_id = ?",
        joined.outcomes[0]?.bookId as string,
      ),
    ).toEqual([{ section_id: sectionId }]);

    const { id: doomed } = createSection(library.database, { name: "Gone" });
    const fallback = await importBatch(
      library,
      [put("Story.epub", fixture("reflowable.epub"))],
      {
        sectionId: doomed,
        checkpoint(_, step) {
          if (step === "published") deleteSection(library.database, doomed);
        },
      },
    );
    expect(fallback.outcomes[0]).toMatchObject({
      kind: "imported",
      message:
        "Imported as “Story” into Unfiled: the target section was deleted during the import.",
    });
    expect(rows("SELECT book_id FROM section_memberships")).toHaveLength(1);

    await expect(
      importBatch(library, [put("Other.pdf", fixture("image-only.pdf"))], {
        sectionId: doomed,
      }),
    ).rejects.toMatchObject({ code: "unknown-section" });
    expect(titles()).toEqual(["Atlas", "Story"]);
  });

  it.each(["copying", "published"] as const)(
    "cancels at %s: keeps completed books, rolls back the current copy, and skips the rest",
    async (step) => {
      const large = Buffer.concat([
        Buffer.from("%PDF-1.7\n"),
        Buffer.alloc(2 * 1024 * 1024 + 123, 0x41),
      ]);
      const inputs = [
        put("A.pdf", fixture("known.pdf")),
        put("Large.pdf", large),
        put("C.epub", fixture("reflowable.epub")),
      ];
      const before = snapshot(sources);
      const controller = new AbortController();

      const summary = await importBatch(library, inputs, {
        signal: controller.signal,
        checkpoint(name, reached) {
          if (name === "Large.pdf" && reached === step) controller.abort();
        },
      });

      expect(brief(summary)).toEqual([
        { name: "A.pdf", kind: "imported" },
        { name: "Large.pdf", kind: "cancelled" },
        { name: "C.epub", kind: "cancelled" },
      ]);
      expect(summary.cancelled).toBe(true);
      expect(titles()).toEqual(["A"]);
      expect(managed("files")).toHaveLength(1);
      expect(managed("staging")).toEqual([]);
      expect(
        rows("SELECT state FROM recovery_operations ORDER BY state"),
      ).toEqual([{ state: "abandoned" }, { state: "committed" }]);
      expect(snapshot(sources)).toEqual(before);
    },
  );

  it("lets each file fail on its own: unreadable, missing, special and storage failures", async () => {
    const locked = put("Locked.pdf", fixture("known.pdf"));
    chmodSync(locked, 0o000);
    const fifo = join(sources, "Pipe.epub");
    execFileSync("mkfifo", [fifo]);
    try {
      const summary = await importBatch(
        library,
        [
          locked,
          join(sources, "Missing.pdf"),
          fifo,
          put("Broken by disk.epub", fixture("reflowable.epub")),
          put("Atlas.pdf", fixture("known.pdf")),
        ],
        {
          checkpoint(name, step) {
            if (name === "Broken by disk.epub" && step === "renamed")
              throw new Error("ENOSPC: no space left on device");
          },
        },
      );
      expect(brief(summary)).toEqual([
        { name: "Locked.pdf", kind: "failed" },
        { name: "Missing.pdf", kind: "failed" },
        { name: "Pipe.epub", kind: "unsupported" },
        { name: "Broken by disk.epub", kind: "failed" },
        { name: "Atlas.pdf", kind: "imported" },
      ]);
      expect(summary.outcomes[0]?.message).toMatch(
        /^Locked\.pdf could not be read \(.*EACCES/,
      );
      expect(summary.outcomes[3]?.message).toBe(
        "Broken by disk.epub could not be added (ENOSPC: no space left on device). No book was created.",
      );
      expect(titles()).toEqual(["Atlas"]);
      expect(managed("files")).toHaveLength(1);
      expect(managed("staging")).toEqual([]);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it("never scans or imports the library's own folder", async () => {
    const atlas = put("Atlas.pdf", fixture("known.pdf"));
    await importBatch(library, [atlas]);
    const [published] = managed("files");
    symlinkSync(
      join(root, "files", published as string),
      join(sources, "Managed link.pdf"),
    );
    put("Story.epub", fixture("reflowable.epub"));
    rmSync(atlas);

    // The temporary folder holds both the sources and the library root.
    const summary = await importBatch(library, [
      temporary,
      join(root, "files", published as string),
    ]);
    const name = temporary.split("/").at(-1) as string;
    expect(brief(summary)).toEqual([
      { name: `${name}/library`, kind: "skipped" },
      { name: `${name}/sources/Managed link.pdf`, kind: "skipped" },
      { name: `${name}/sources/Story.epub`, kind: "imported" },
      { name: published, kind: "skipped" },
    ]);
    expect(titles()).toEqual(["Atlas", "Story"]);
  });

  it("processes each resolved input once", async () => {
    const shelf = join(sources, "Shelf");
    const atlas = put("Shelf/Atlas.pdf", fixture("known.pdf"));
    const summary = await importBatch(library, [shelf, atlas, shelf]);
    expect(brief(summary)).toEqual([
      { name: "Shelf/Atlas.pdf", kind: "imported" },
    ]);
    expect(statSync(atlas).isFile()).toBe(true);
  });

  it.each([
    [[]],
    [["relative/Atlas.pdf"]],
    ["/an/absolute/string.pdf"],
    [[42]],
  ])("refuses an invalid selection %j", async (inputs) => {
    await expect(importBatch(library, inputs)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(rows("SELECT id FROM recovery_operations")).toEqual([]);
  });
});

it("copies explicitly selected file symlinks without touching their targets", async () => {
  const target = join(sources, "Real.pdf");
  copyFileSync("tests/fixtures/known.pdf", target);
  const link = join(sources, "Chosen link.pdf");
  symlinkSync(target, link);
  const summary = await importBatch(library, [link]);
  expect(brief(summary)).toEqual([
    { name: "Chosen link.pdf", kind: "imported" },
  ]);
  expect(titles()).toEqual(["Chosen link"]);
  expect(readFileSync(target)).toEqual(fixture("known.pdf"));
});

it("requires a per-file metadata choice and Keep Both creates a separate section member", async () => {
  const inspect = async () => ({
    title: "The Atlas",
    authors: ["Ada Reader"],
    subjects: [],
    cover: null,
    warnings: [],
  });
  const first = await addFileAsNewBook(
    library,
    put("one.pdf", fixture("known.pdf")),
    { inspect },
  );
  const section = createSection(library.database, {
    name: "New shelf",
    parentId: null,
  });
  let prompted = false;
  const summary = await importBatch(
    library,
    [put("two.pdf", fixture("image-only.pdf"))],
    {
      inspect,
      sectionId: section.id,
      chooseDuplicate: async (prompt) => {
        prompted = true;
        expect(prompt.candidates.map((c) => c.bookId)).toEqual([first.bookId]);
        return { action: "keep-both" };
      },
    },
  );
  expect(prompted).toBe(true);
  expect(summary.outcomes[0]?.kind).toBe("imported");
  expect(titles()).toEqual(["The Atlas", "The Atlas"]);
  expect(rows("SELECT book_id FROM section_memberships")).toEqual([
    { book_id: summary.outcomes[0]?.bookId },
  ]);
});

const metadata =
  (title: string | null = "The Atlas", authors = ["Ada Reader"]) =>
  async () => ({ title, authors, subjects: [], cover: null, warnings: [] });

it("matches normalized effective metadata across all live candidates, including Archive, and Skip leaves memberships untouched", async () => {
  const a = await addFileAsNewBook(
    library,
    put("a.pdf", fixture("known.pdf")),
    { inspect: metadata("  THE   ATLAS ", ["ＡＤＡ Reader"]) },
  );
  const b = await addFileAsNewBook(
    library,
    put("b.epub", fixture("reflowable.epub")),
    {
      inspect: metadata(),
      chooseDuplicate: async () => ({ action: "keep-both" }),
    },
  );
  archiveBook(library.database, a.bookId);
  const result = await importBatch(
    library,
    [put("c.pdf", fixture("image-only.pdf"))],
    {
      inspect: metadata("the atlas", ["Someone Else", "ada reader"]),
      chooseDuplicate: async (prompt) => {
        expect(prompt.candidates.map((c) => c.bookId).sort()).toEqual(
          [a.bookId, b.bookId].sort(),
        );
        expect(
          prompt.candidates.find((c) => c.bookId === a.bookId)?.archived,
        ).toBe(true);
        return { action: "skip" };
      },
    },
  );
  expect(result.outcomes[0]?.kind).toBe("skipped");
  expect(titles()).toHaveLength(2);
  expect(managed("staging")).toEqual([]);
  expect(managed("files")).toHaveLength(2);
});

it.each([
  [null, ["Ada Reader"]],
  ["The Atlas", []],
  ["The Atlas!", ["Ada Reader"]],
  ["The Atlas", ["Other"]],
] as [string | null, string[]][])(
  "does not guess duplicates for title %s and authors %s",
  async (title, authors) => {
    await addFileAsNewBook(library, put("first.pdf", fixture("known.pdf")), {
      inspect: metadata(),
    });
    let prompted = false;
    const result = await importBatch(
      library,
      [put("The Atlas.pdf", fixture("image-only.pdf"))],
      {
        inspect: metadata(title, authors),
        chooseDuplicate: async () => {
          prompted = true;
          return { action: "skip" };
        },
      },
    );
    expect(prompted).toBe(false);
    expect(result.outcomes[0]?.kind).toBe("imported");
  },
);

it("replaces exactly the chosen candidate and keeps its state and old revision in Trash", async () => {
  const a = await addFileAsNewBook(
    library,
    put("a.pdf", fixture("known.pdf")),
    { inspect: metadata() },
  );
  const b = await addFileAsNewBook(
    library,
    put("b.epub", fixture("reflowable.epub")),
    {
      inspect: metadata(),
      chooseDuplicate: async () => ({ action: "keep-both" }),
    },
  );
  archiveBook(library.database, b.bookId);
  const section = createSection(library.database, {
    name: "Target",
    parentId: null,
  });
  library.database
    .prepare("INSERT INTO section_memberships VALUES (?, ?, 1)")
    .run(section.id, b.bookId);
  let retired = false;
  const result = await importBatch(
    library,
    [put("new.pdf", fixture("image-only.pdf"))],
    {
      inspect: metadata(),
      chooseDuplicate: async () => ({ action: "replace", bookId: b.bookId }),
      beforeReplacement: (id) => {
        expect(id).toBe(b.bookId);
        retired = true;
      },
    },
  );
  expect(retired).toBe(true);
  expect(result.outcomes[0]?.message).toContain("Replaced file");
  expect(result.outcomes[0]?.bookId).toBe(b.bookId);
  expect(
    rows("SELECT current_revision_id FROM books WHERE id = ?", a.bookId),
  ).toEqual([{ current_revision_id: a.revisionId }]);
  expect(rows("SELECT revision_id FROM trash_entries")).toEqual([
    { revision_id: b.revisionId },
  ]);
  expect(rows("SELECT book_id FROM section_memberships")).toEqual([
    { book_id: b.bookId },
  ]);
  expect(
    rows("SELECT archived_at FROM books WHERE id = ?", b.bookId)[0]
      ?.archived_at,
  ).not.toBeNull();
  expect(managed("files")).toHaveLength(3);
});

it.each(["stale", "unlisted", "cancel", "flush"])(
  "preserves the target and cleans staging on %s choice failure",
  async (mode) => {
    const original = await addFileAsNewBook(
      library,
      put("a.pdf", fixture("known.pdf")),
      { inspect: metadata() },
    );
    const controller = new AbortController();
    const result = await importBatch(
      library,
      [put("b.pdf", fixture("image-only.pdf"))],
      {
        inspect: metadata(),
        signal: controller.signal,
        chooseDuplicate: async () => {
          if (mode === "cancel") controller.abort();
          if (mode === "stale")
            library.database
              .prepare("UPDATE books SET deleted_at = 1 WHERE id = ?")
              .run(original.bookId);
          return {
            action: "replace",
            bookId: mode === "unlisted" ? "unlisted" : original.bookId,
          };
        },
        beforeReplacement: () => {
          if (mode === "flush") throw new Error("Cannot flush reader");
        },
      },
    );
    expect(result.outcomes[0]?.kind).toBe(
      mode === "cancel"
        ? "cancelled"
        : mode === "unlisted"
          ? "skipped"
          : "failed",
    );
    expect(rows("SELECT current_revision_id FROM books")).toEqual([
      { current_revision_id: original.revisionId },
    ]);
    expect(rows("SELECT * FROM trash_entries")).toEqual([]);
    expect(managed("files")).toHaveLength(1);
    expect(managed("staging")).toEqual([]);
  },
);
