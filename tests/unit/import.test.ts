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
import {
  formatFromName,
  sniffFormat,
  titleFromName,
} from "../../src/library/formats";
import {
  addFileAsNewBook,
  ImportError,
  type ImportStep,
} from "../../src/library/import";
import { beginReaderSession } from "../../src/library/progress";
import { readOperation, reconcileOperations } from "../../src/library/recovery";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { publishFile } from "../../src/storage/files";
import { kill, killChildren, startChild } from "./library-fixtures";

// `sha256sum` of the committed fixtures, computed outside this code.
const KNOWN_PDF_SHA256 =
  "78051a530467896fd68734fbdb36a30d3c54d1a9b82712e6c10dffa1922a4f02";
const REFLOWABLE_EPUB_SHA256 =
  "bb840c53ebfcb5cd88623fc4bf3d2819099223d6decac2135cf86d44f149adbb";

let temporary: string;
let root: string;
let sources: string;
let library: Library | undefined;

function reopen(): Library {
  library?.close();
  library = openLibrary({ root });
  return library;
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "borges-import-"));
  root = join(temporary, "library");
  sources = join(temporary, "sources");
  mkdirSync(sources);
  reopen();
});
afterEach(() => {
  killChildren();
  library?.close();
  library = undefined;
  chmodSync(temporary, 0o700);
  rmSync(temporary, { recursive: true, force: true });
});

const fixture = (name: string) => join("tests/fixtures", name);
function source(name: string, bytes: Buffer | string): string {
  const path = join(sources, name);
  writeFileSync(path, bytes);
  return path;
}
/** A PDF-headed file spanning several copy chunks. */
const largePdf = () =>
  source(
    "Large Atlas.pdf",
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(2 * 1024 * 1024 + 123, 0x41),
    ]),
  );

const managed = (directory: "staging" | "files") =>
  readdirSync(join(root, directory)).sort();
const rows = (sql: string) => (library as Library).database.prepare(sql).all();
const operations = () =>
  rows("SELECT state, kind FROM recovery_operations").map((row) => ({
    ...row,
  }));

/** Nothing of the interrupted/failed import remains and no book exists. */
function expectRolledBack(sourcePath: string, sourceBytes: Buffer) {
  expect(rows("SELECT id FROM books")).toEqual([]);
  expect(rows("SELECT id FROM revisions")).toEqual([]);
  expect(operations()).toEqual([{ state: "abandoned", kind: "import" }]);
  expect(managed("staging")).toEqual([]);
  expect(managed("files")).toEqual([]);
  expect(readFileSync(sourcePath).equals(sourceBytes)).toBe(true);
}

describe("format sniffing", () => {
  const epub = readFileSync(fixture("reflowable.epub"));
  const patched = (from: string, to: string) =>
    Buffer.from(epub.toString("latin1").replaceAll(from, to), "latin1");

  it.each([
    ["known.pdf", readFileSync(fixture("known.pdf")), "pdf"],
    ["image-only.pdf", readFileSync(fixture("image-only.pdf")), "pdf"],
    ["reflowable.epub", epub, "epub"],
    ["fixed.epub", readFileSync(fixture("fixed.epub")), "epub"],
    ["late PDF header within 1 KiB", `${" ".repeat(1000)}%PDF-1.4\n`, "pdf"],
    ["PDF header after 1 KiB", `${" ".repeat(1100)}%PDF-1.4\n`, null],
    ["empty file", "", null],
    ["plain text", "Not a book at all.\n", null],
    ["truncated EPUB", epub.subarray(0, epub.length / 2), null],
    [
      "ZIP without container.xml",
      patched("META-INF/container.xml", "META-INF/containex.xml"),
      null,
    ],
    [
      "ZIP with another mimetype",
      patched("application/epub+zip", "application/epub+zap"),
      null,
    ],
  ] as const)("%s → %s", async (_name, bytes, expected) => {
    await expect(sniffFormat(source("sample", bytes))).resolves.toBe(expected);
  });

  it("derives the claimed format and fallback title from the file name", () => {
    expect(formatFromName("Atlas.PDF")).toBe("pdf");
    expect(formatFromName("Labyrinths.epub")).toBe("epub");
    expect(formatFromName("notes.txt")).toBeNull();
    expect(formatFromName("pdf")).toBeNull();
    expect(titleFromName("Ficciones (1944).v2.epub")).toBe(
      "Ficciones (1944).v2",
    );
    expect(titleFromName(".pdf")).toBe(".pdf");
  });
});

describe("adding a file as a new book", () => {
  it.each([
    ["known.pdf", "pdf", "known", KNOWN_PDF_SHA256],
    ["reflowable.epub", "epub", "reflowable", REFLOWABLE_EPUB_SHA256],
  ] as const)(
    "copies %s into immutable storage and creates an Unread book",
    async (name, format, title, sha256) => {
      const path = join(sources, name);
      copyFileSync(fixture(name), path);
      const before = statSync(path);
      const added = await addFileAsNewBook(reopen(), path);

      expect(added).toMatchObject({
        format,
        title,
        sha256,
        size: before.size,
        path: `files/${added.revisionId}.${format}`,
      });
      expect(
        readFileSync(join(root, added.path)).equals(
          readFileSync(fixture(name)),
        ),
      ).toBe(true);
      // Source is only read.
      expect(readFileSync(path).equals(readFileSync(fixture(name)))).toBe(true);
      expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
      expect(managed("staging")).toEqual([]);

      // Durable across a restart, as an Unread, unarchived, unfiled book.
      const reopened = reopen();
      expect(rows("SELECT * FROM books")).toMatchObject([
        {
          id: added.bookId,
          current_revision_id: added.revisionId,
          title,
          reading_status: "unread",
          archived_at: null,
          deleted_at: null,
        },
      ]);
      expect(rows("SELECT * FROM revisions")).toMatchObject([
        {
          id: added.revisionId,
          format,
          path: added.path,
          sha256,
          size: before.size,
          original_filename: name,
          retired_at: null,
        },
      ]);
      expect(rows("SELECT * FROM section_memberships")).toEqual([]);
      expect(readOperation(reopened.database, added.operationId)).toMatchObject(
        {
          state: "committed",
          bookId: added.bookId,
          revisionId: added.revisionId,
          publishedPath: added.path,
        },
      );
      expect(await reconcileOperations(reopened)).toEqual({
        operations: [],
        unrecognized: [],
      });
      // The catalog entry is usable by the progress service.
      expect(beginReaderSession(reopened.database, added.bookId)).toMatchObject(
        { revisionId: added.revisionId, format, location: null },
      );
    },
  );

  it("rejects unsupported names and unreadable sources before recording anything", async () => {
    const current = reopen();
    mkdirSync(join(sources, "folder.pdf"));
    for (const [path, code] of [
      [source("notes.txt", "%PDF-1.4\n"), "unsupported"],
      [join(sources, "missing.pdf"), "unreadable"],
      [join(sources, "folder.pdf"), "unreadable"],
    ] as const) {
      await expect(addFileAsNewBook(current, path)).rejects.toMatchObject({
        name: "ImportError",
        code,
      });
    }
    expect(rows("SELECT id FROM recovery_operations")).toEqual([]);
    expect(managed("staging")).toEqual([]);
  });

  it.each([
    [
      "Wrong.epub",
      "%PDF-1.4\nbody\n",
      "mismatched",
      /named as EPUB but contains PDF/,
    ],
    [
      "Wrong.pdf",
      readFileSync(fixture("reflowable.epub")),
      "mismatched",
      /named as PDF but contains EPUB/,
    ],
    [
      "Noise.pdf",
      "not really a document",
      "unsupported",
      /does not contain PDF/,
    ],
  ] as const)(
    "rejects %s by content and rolls its staged copy back",
    async (name, bytes, code, reason) => {
      const path = source(name, bytes);
      const error = await addFileAsNewBook(reopen(), path).catch((e) => e);
      expect(error).toBeInstanceOf(ImportError);
      expect(error).toMatchObject({
        code,
        message: expect.stringMatching(reason),
      });
      expectRolledBack(path, Buffer.from(bytes));
    },
  );

  it.each([
    "pending",
    "copying",
    "staged",
    "renamed",
    "published",
    "committing",
  ] as const)(
    "rolls back a failure at %s without leaving partial or published bytes",
    async (step) => {
      const path = largePdf();
      const bytes = readFileSync(path);
      const error = await addFileAsNewBook(reopen(), path, {
        checkpoint(reached) {
          if (reached === step) throw new Error(`injected at ${step}`);
        },
      }).catch((e) => e);
      expect(error).toMatchObject({
        code: "storage-failed",
        message: expect.stringContaining(`injected at ${step}`),
      });
      expectRolledBack(path, bytes);
    },
  );

  it("refuses to publish over an existing managed file", async () => {
    const staged = join(root, "staging", "new.partial");
    const target = join(root, "files", "existing.pdf");
    writeFileSync(staged, "new");
    writeFileSync(target, "old");
    await expect(publishFile(staged, target)).rejects.toThrow(/overwrite/);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readFileSync(staged, "utf8")).toBe("new");
  });

  // Permission bits do not restrict root, so the removal would not fail.
  it.skipIf(process.getuid?.() === 0)(
    "keeps a rollback that cannot remove its file open for the next startup",
    async () => {
      const path = largePdf();
      const bytes = readFileSync(path);
      let operationId = "";
      const error = await addFileAsNewBook(reopen(), path, {
        checkpoint(step) {
          if (step !== "renamed") return;
          operationId = String(
            rows("SELECT id FROM recovery_operations")[0]?.id,
          );
          chmodSync(join(root, "files"), 0o500);
          throw new Error("injected after publication");
        },
      }).catch((e) => e);
      chmodSync(join(root, "files"), 0o700);
      expect(error).toMatchObject({ code: "storage-failed" });
      const published = managed("files");
      expect(published).toHaveLength(1);
      expect(
        readOperation((library as Library).database, operationId),
      ).toMatchObject({
        state: "staged",
        publishedPath: `files/${published[0]}`,
      });

      // Still unremovable at the next start: retried, kept open, and reported
      // once as an operation rather than also as an unrecognized file.
      chmodSync(join(root, "files"), 0o500);
      const retry = await reconcileOperations(reopen());
      chmodSync(join(root, "files"), 0o700);
      expect(retry).toMatchObject({
        operations: [
          { outcome: "retained", retained: [`files/${published[0]}`] },
        ],
        unrecognized: [],
      });
      expect(operations()).toEqual([{ state: "staged", kind: "import" }]);

      const report = await reconcileOperations(reopen());
      expect(report.operations).toMatchObject([
        {
          operationId,
          previousState: "staged",
          outcome: "rolled-back",
          removed: [`files/${published[0]}`],
        },
      ]);
      expectRolledBack(path, bytes);
    },
  );
});

describe("startup reconciliation after a killed import", () => {
  // What the killed process left behind, checked before reconciling.
  const leftovers: Record<
    Exclude<ImportStep, "committed">,
    { state: string; staging: number; files: number }
  > = {
    pending: { state: "pending", staging: 0, files: 0 },
    copying: { state: "pending", staging: 1, files: 0 },
    staged: { state: "staged", staging: 1, files: 0 },
    renamed: { state: "staged", staging: 0, files: 1 },
    published: { state: "published", staging: 0, files: 1 },
    // The catalog transaction was open, never committed.
    committing: { state: "published", staging: 0, files: 1 },
  };

  it.each(Object.entries(leftovers))(
    "rolls back an import killed at %s",
    async (step, expected) => {
      const path = largePdf();
      const bytes = readFileSync(path);
      library?.close();
      library = undefined;
      const child = await startChild(
        "import-and-stop",
        root,
        `at ${step}`,
        path,
        step,
      );
      await kill(child);

      const current = reopen();
      expect(operations()).toEqual([{ state: expected.state, kind: "import" }]);
      expect(managed("staging")).toHaveLength(expected.staging);
      expect(managed("files")).toHaveLength(expected.files);
      if (step === "copying") {
        // A genuinely partial copy, not an empty or complete file.
        const partial = statSync(
          join(root, "staging", managed("staging")[0] as string),
        );
        expect(partial.size).toBeGreaterThan(0);
        expect(partial.size).toBeLessThan(bytes.length);
      }
      const leftover = [
        ...managed("staging").map((n) => `staging/${n}`),
        ...managed("files").map((n) => `files/${n}`),
      ];

      const report = await reconcileOperations(current);
      expect(report).toMatchObject({
        operations: [
          {
            previousState: expected.state,
            outcome: "rolled-back",
            removed: leftover,
          },
        ],
        unrecognized: [],
      });
      expectRolledBack(path, bytes);
      // Settled: a second startup has nothing to do.
      expect(await reconcileOperations(reopen())).toEqual({
        operations: [],
        unrecognized: [],
      });
    },
  );

  it("keeps an import killed right after its catalog commit", async () => {
    const path = largePdf();
    library?.close();
    library = undefined;
    await kill(
      await startChild(
        "import-and-stop",
        root,
        "at committed",
        path,
        "committed",
      ),
    );
    const current = reopen();
    const [book] = rows(
      "SELECT b.title, r.path, r.size FROM books b JOIN revisions r ON r.id = b.current_revision_id",
    );
    expect(book).toMatchObject({
      title: "Large Atlas",
      size: statSync(path).size,
    });
    expect(await reconcileOperations(current)).toEqual({
      operations: [],
      unrecognized: [],
    });
    expect(
      readFileSync(join(root, String(book?.path))).equals(readFileSync(path)),
    ).toBe(true);
  });

  it("retains bytes that no longer match the record, and stray files, on every startup", async () => {
    const path = largePdf();
    library?.close();
    library = undefined;
    await kill(
      await startChild(
        "import-and-stop",
        root,
        "at published",
        path,
        "published",
      ),
    );
    const [published] = readdirSync(join(root, "files"));
    const publishedPath = `files/${published}`;
    writeFileSync(join(root, publishedPath), "damaged", { flag: "a" });
    writeFileSync(join(root, "staging", "stray.partial"), "unknown");
    writeFileSync(join(root, "files", "orphan.pdf"), "%PDF-1.4\n");

    for (const previousState of ["published", "failed"]) {
      const report = await reconcileOperations(reopen());
      expect(report).toMatchObject({
        operations: [
          {
            previousState,
            outcome: "retained",
            removed: [],
            retained: [publishedPath],
          },
        ],
        unrecognized: ["staging/stray.partial", "files/orphan.pdf"],
      });
      expect(report.operations[0]?.message).toMatch(
        /does not match the recorded copy/,
      );
      expect(operations()).toEqual([{ state: "failed", kind: "import" }]);
      expect(managed("files").sort()).toEqual([published, "orphan.pdf"].sort());
      expect(managed("staging")).toEqual(["stray.partial"]);
    }
    expect(rows("SELECT id FROM books")).toEqual([]);
  });

  it("retains a symlink found at a staged path instead of following or removing it", async () => {
    const path = largePdf();
    library?.close();
    library = undefined;
    await kill(
      await startChild("import-and-stop", root, "at pending", path, "pending"),
    );
    const current = reopen();
    const staged = String(
      rows("SELECT staged_path FROM recovery_operations")[0]?.staged_path,
    );
    symlinkSync(path, join(root, staged));
    const report = await reconcileOperations(current);
    expect(report.operations).toMatchObject([
      { outcome: "retained", retained: [staged] },
    ]);
    expect(report.operations[0]?.message).toMatch(/not a regular file/);
    expect(operations()).toEqual([{ state: "failed", kind: "import" }]);
    expect(readFileSync(path).length).toBeGreaterThan(2 * 1024 * 1024);
    expect(managed("staging")).toHaveLength(1);
  });
});
