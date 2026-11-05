import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { editMetadata } from "../../src/library/books";
import { addFileAsNewBook, replaceBookFile } from "../../src/library/import";
import { beginReaderSession, saveProgress } from "../../src/library/progress";
import { getBook } from "../../src/library/query";
import { reconcileOperations } from "../../src/library/recovery";
import { restoreRevision } from "../../src/library/revision-restore";
import { listTrash } from "../../src/library/trash";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { kill, killChildren, startChild } from "./library-fixtures";

let root: string;
let library: Library;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "borges-revision-"));
  library = openLibrary({ root });
});
afterEach(() => {
  killChildren();
  library.close();
  rmSync(root, { recursive: true, force: true });
});
async function seed() {
  const old = await addFileAsNewBook(library, "tests/fixtures/known.pdf");
  const grant = beginReaderSession(library.database, old.bookId);
  saveProgress(library.database, {
    ...grant,
    sequence: 1,
    location: { format: "pdf", page: 3, x: 0, y: 0.5 },
    sizing: { fontSize: 18, zoom: 2 },
  });
  const next = await replaceBookFile(
    library,
    old.bookId,
    "tests/fixtures/reflowable.epub",
  );
  const entry = (await listTrash(library)).entries[0];
  if (!entry) throw new Error("no old revision");
  return { old, next, entry };
}
it("restores the original revision and saved position, preserves manual details and puts the displaced file in Trash", async () => {
  const { old, next, entry } = await seed();
  editMetadata(library.database, old.bookId, {
    title: "My Atlas",
    authors: ["Ana"],
  });
  const restored = await restoreRevision(library, entry.id, "current");
  expect(restored.bookId).toBe(old.bookId);
  expect(getBook(library.database, old.bookId)).toMatchObject({
    title: "My Atlas",
    authors: ["Ana"],
    format: "pdf",
  });
  expect(
    beginReaderSession(library.database, old.bookId).location,
  ).toMatchObject({ format: "pdf", page: 3, y: 0.5 });
  expect((await listTrash(library)).entries).toMatchObject([
    { revisionId: next.revisionId },
  ]);
  expect(readFileSync(join(root, old.path))).toEqual(
    readFileSync("tests/fixtures/known.pdf"),
  );
});

it("restores a separate Unread copy with extracted rather than manual details, no membership or position, and retains old Trash", async () => {
  const { old, entry } = await seed();
  editMetadata(library.database, old.bookId, {
    title: "Manual name",
    authors: ["Manual author"],
  });
  const section = library.database.prepare(
    "INSERT INTO sections (id, name, name_key, created_at) VALUES ('s', 'Shelf', 'shelf', 1)",
  );
  section.run();
  library.database
    .prepare("INSERT INTO section_memberships VALUES ('s', ?, 1)")
    .run(old.bookId);
  const separate = await restoreRevision(library, entry.id, "separate");
  expect(separate.bookId).not.toBe(old.bookId);
  expect(getBook(library.database, separate.bookId)).toMatchObject({
    title: "known",
    authors: [],
    status: "unread",
    archived: false,
  });
  expect(
    beginReaderSession(library.database, separate.bookId).location,
  ).toBeNull();
  expect(
    library.database
      .prepare("SELECT * FROM section_memberships WHERE book_id = ?")
      .all(separate.bookId),
  ).toEqual([]);
  expect((await listTrash(library)).entries).toMatchObject([{ id: entry.id }]);
  expect(getBook(library.database, old.bookId).title).toBe("Manual name");
  await expect(
    restoreRevision(library, entry.id, "current"),
  ).rejects.toMatchObject({ bookId: separate.bookId });
});

it.each(["missing", "modified", "flush", "commit", "stale"])(
  "refuses %s restoration without changing the current revision or Trash",
  async (mode) => {
    const { old, next, entry } = await seed();
    if (mode === "missing") rmSync(join(root, old.path));
    if (mode === "modified") {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(root, old.path), "altered bytes");
    }
    if (mode === "commit")
      library.database.exec(
        "CREATE TRIGGER refuse_switch BEFORE UPDATE OF current_revision_id ON books BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      );
    await expect(
      restoreRevision(library, entry.id, "current", {
        ...(mode === "stale" ? { expectedCurrentId: "stale" } : {}),
        beforeCommit() {
          if (mode === "flush") throw new Error("cannot flush");
        },
      }),
    ).rejects.toThrow();
    expect(
      library.database
        .prepare("SELECT current_revision_id FROM books WHERE id = ?")
        .get(old.bookId)?.current_revision_id,
    ).toBe(next.revisionId);
    expect((await listTrash(library)).entries).toMatchObject([
      { id: entry.id },
    ]);
  },
);

it("permits separate reuse from a deleted owner, but requires restoring the book before switching its current revision", async () => {
  const { old, entry } = await seed();
  const { deleteBook } = await import("../../src/library/trash");
  deleteBook(library.database, old.bookId);
  await expect(restoreRevision(library, entry.id, "current")).rejects.toThrow(
    "Restore the deleted book first",
  );
  const copy = await restoreRevision(library, entry.id, "separate");
  expect(getBook(library.database, copy.bookId).status).toBe("unread");
  expect((await listTrash(library)).entries).toHaveLength(2);
});

it("requires Trash-only import choice; cancellation retains Trash and restore reuses deleted-book state without creating another copy", async () => {
  const { importBatch } = await import("../../src/library/import-batch");
  const { deleteBook } = await import("../../src/library/trash");
  const old = await addFileAsNewBook(library, "tests/fixtures/known.pdf");
  const deleted = deleteBook(library.database, old.bookId);
  let prompts = 0;
  const skipped = await importBatch(
    library,
    ["tests/fixtures/known.pdf"].map((p) => join(process.cwd(), p)),
    {
      chooseTrash: async (prompt) => {
        prompts++;
        expect(prompt.candidates.map((c) => c.entryId)).toEqual([deleted.id]);
        return { action: "cancel" };
      },
    },
  );
  expect(prompts).toBe(1);
  expect(skipped.outcomes[0]?.kind).toBe("skipped");
  const restored = await importBatch(
    library,
    [join(process.cwd(), "tests/fixtures/known.pdf")],
    {
      chooseTrash: async () => ({
        action: "restore",
        entryId: deleted.id,
        mode: "book",
      }),
    },
  );
  expect(restored.outcomes[0]).toMatchObject({
    kind: "restored",
    bookId: old.bookId,
  });
  expect((await listTrash(library)).entries).toEqual([]);
});

it.each(["current", "separate", "cancel", "stale"])(
  "handles Trash-only revision import via %s without silent replacement",
  async (mode) => {
    const { old, next, entry } = await seed();
    const { importBatch } = await import("../../src/library/import-batch");
    const controller = new AbortController();
    const summary = await importBatch(
      library,
      [join(process.cwd(), "tests/fixtures/known.pdf")],
      {
        signal: controller.signal,
        chooseTrash: async () => {
          if (mode === "cancel") controller.abort();
          return {
            action: "restore",
            entryId: mode === "stale" ? "unknown" : entry.id,
            mode: mode === "current" ? "current" : "separate",
          };
        },
      },
    );
    expect(summary.outcomes[0]?.kind).toBe(
      mode === "cancel"
        ? "cancelled"
        : mode === "stale"
          ? "skipped"
          : "restored",
    );
    expect(
      library.database
        .prepare("SELECT current_revision_id FROM books WHERE id = ?")
        .get(old.bookId)?.current_revision_id,
    ).toBe(mode === "current" ? old.revisionId : next.revisionId);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  },
);

it.each([
  "current-committing",
  "current-committed",
  "separate-published",
  "separate-committed",
  "prompt",
])("recovers from real process kill at %s", async (scenario) => {
  const { old, next, entry } = await seed();
  library.close();
  const separate = scenario.startsWith("separate");
  const step =
    scenario === "prompt" ? "prompt" : (scenario.split("-")[1] as string);
  const child =
    scenario === "prompt"
      ? await startChild(
          "trash-choice-and-stop",
          root,
          "at prompt",
          join(process.cwd(), "tests/fixtures/known.pdf"),
        )
      : await startChild(
          "revision-and-stop",
          root,
          `at ${step}`,
          entry.id,
          separate ? "separate" : "current",
          step,
        );
  await kill(child);
  library = openLibrary({ root });
  const report = await reconcileOperations(library);
  expect(report.unrecognized).toEqual([]);
  expect(
    library.database
      .prepare("SELECT current_revision_id FROM books WHERE id = ?")
      .get(old.bookId)?.current_revision_id,
  ).toBe(!separate && step === "committed" ? old.revisionId : next.revisionId);
  expect(
    library.database
      .prepare("SELECT count(*) AS n FROM books WHERE deleted_at IS NULL")
      .get()?.n,
  ).toBe(separate && step === "committed" ? 2 : 1);
  expect((await listTrash(library)).entries).toHaveLength(1);
  expect(readFileSync(join(root, old.path))).toEqual(
    readFileSync("tests/fixtures/known.pdf"),
  );
});

it("cancels a deleted-book import restore before its catalog commit", async () => {
  const { deleteBook, restoreDeletedBook } = await import(
    "../../src/library/trash"
  );
  const old = await addFileAsNewBook(library, "tests/fixtures/known.pdf");
  const entry = deleteBook(library.database, old.bookId);
  const controller = new AbortController();
  const restoring = restoreDeletedBook(
    library,
    entry.id,
    undefined,
    controller.signal,
  );
  controller.abort();
  await expect(restoring).rejects.toThrow("cancelled");
  expect((await listTrash(library)).entries).toHaveLength(1);
});
