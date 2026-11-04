import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  coverToken,
  inspectCoverImage,
  MAX_COVER_BYTES,
} from "../../src/library/cover-image";
import { readCover, setManualCover } from "../../src/library/covers";
import { reconcileOperations } from "../../src/library/recovery";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { catalogMigrations } from "../../src/storage/schema";
import { addBook, kill, killChildren, startChild } from "./library-fixtures";

// Created 1×1 PNG; actual Electron decoding is covered by native tests.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=",
  "base64",
);
const normalize = (bytes: Buffer) => bytes;
let temporary: string;
let library: Library;
let source: string;
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "borges-covers-"));
  library = openLibrary({ root: join(temporary, "library") });
  addBook(library.database, { book: "b1", revision: "r1", title: "Atlas" });
  source = join(temporary, "image.bin");
  writeFileSync(source, png);
});
afterEach(() => {
  killChildren();
  library.close();
  rmSync(temporary, { recursive: true, force: true });
});
const book = () =>
  library.database
    .prepare(
      "SELECT cover_path, cover_manual, title FROM books WHERE id = 'b1'",
    )
    .get();

it("migrates schema 2 with a snapshot and preserves recovery records", () => {
  library.close();
  rmSync(library.root, { recursive: true });
  library = openLibrary({
    root: library.root,
    migrations: catalogMigrations.slice(0, 2),
  });
  library.database.exec(
    "INSERT INTO recovery_operations (id, kind, state, detail, created_at, updated_at) VALUES ('old', 'replace', 'failed', '{\"reason\":\"keep\"}', 1, 2)",
  );
  library.close();
  library = openLibrary({ root: library.root });
  expect(library.upgrade).toMatchObject({ from: 2, to: 3 });
  expect(readdirSync(join(library.root, "recovery"))).toEqual([
    expect.stringMatching(/^catalog-schema-2-before-3-/),
  ]);
  expect(
    library.database
      .prepare("SELECT kind, state, detail FROM recovery_operations")
      .get(),
  ).toMatchObject({
    kind: "replace",
    state: "failed",
    detail: '{"reason":"keep"}',
  });
});

it("publishes manual covers without touching the source or deleting an older referenced cover", async () => {
  const first = await setManualCover(library, "b1", source, { normalize });
  expect(book()).toMatchObject({
    cover_path: first.path,
    cover_manual: 1,
    title: "Atlas",
  });
  library.database
    .prepare("UPDATE revisions SET extracted_cover_path = ? WHERE id = 'r1'")
    .run(first.path);
  const second = await setManualCover(library, "b1", source, { normalize });
  expect(second.path).not.toBe(first.path);
  expect(readFileSync(join(library.root, first.path))).toEqual(png);
  expect(readFileSync(join(library.root, second.path))).toEqual(png);
  expect(readFileSync(source)).toEqual(png);
  expect(await reconcileOperations(library)).toEqual({
    operations: [],
    unrecognized: [],
  });
});

it("leaves the working cover unchanged when validation fails", async () => {
  const first = await setManualCover(library, "b1", source, { normalize });
  writeFileSync(source, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await expect(
    setManualCover(library, "b1", source, { normalize }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(book()?.cover_path).toBe(first.path);
  expect(readdirSync(join(library.root, "staging"))).toEqual([]);
  expect(readdirSync(join(library.root, "covers"))).toHaveLength(1);
});

it.each([
  "pending",
  "copying",
  "staged",
  "renamed",
  "published",
  "committing",
] as const)(
  "rolls back a cover failure at %s while preserving the working cover",
  async (step) => {
    const first = await setManualCover(library, "b1", source, { normalize });
    await expect(
      setManualCover(library, "b1", source, {
        normalize,
        checkpoint(reached) {
          if (reached === step) throw new Error(`injected ${step}`);
        },
      }),
    ).rejects.toMatchObject({ code: "storage-failed" });
    expect(book()?.cover_path).toBe(first.path);
    expect(readFileSync(join(library.root, first.path))).toEqual(png);
    expect(readdirSync(join(library.root, "staging"))).toEqual([]);
    expect(readdirSync(join(library.root, "covers"))).toHaveLength(1);
  },
);

it.each([
  "pending",
  "copying",
  "staged",
  "renamed",
  "published",
  "committing",
  "committed",
] as const)("reconciles a real process killed at cover %s", async (step) => {
  const first = await setManualCover(library, "b1", source, { normalize });
  const root = library.root;
  const large = Buffer.concat([png, Buffer.alloc(600_000)]);
  writeFileSync(source, large);
  library.close();
  await kill(
    await startChild("cover-and-stop", root, `at ${step}`, source, step),
  );
  library = openLibrary({ root });
  const report = await reconcileOperations(library);
  if (step === "committed") {
    expect(book()?.cover_path).not.toBe(first.path);
    expect(readFileSync(join(root, String(book()?.cover_path)))).toEqual(large);
    expect(report.operations).toEqual([]);
    expect(readdirSync(join(root, "covers"))).toHaveLength(2);
  } else {
    expect(report.operations).toMatchObject([
      { kind: "cover", outcome: "rolled-back" },
    ]);
    expect(book()?.cover_path).toBe(first.path);
    expect(readdirSync(join(root, "covers"))).toHaveLength(1);
  }
  expect(report.unrecognized).toEqual([]);
  expect(readFileSync(join(root, first.path))).toEqual(png);
  expect(readFileSync(source)).toEqual(large);
  expect(readdirSync(join(root, "staging"))).toEqual([]);
  expect(await reconcileOperations(library)).toEqual({
    operations: [],
    unrecognized: [],
  });
});

it("retains uncertain and catalog-referenced cover bytes during recovery", async () => {
  const first = await setManualCover(library, "b1", source, { normalize });
  const root = library.root;
  library.close();
  await kill(
    await startChild(
      "cover-and-stop",
      root,
      "at published",
      source,
      "published",
    ),
  );
  library = openLibrary({ root });
  const operation = library.database
    .prepare(
      "SELECT id, published_path FROM recovery_operations WHERE state = 'published'",
    )
    .get();
  const path = String(operation?.published_path);
  library.database
    .prepare("UPDATE revisions SET extracted_cover_path = ? WHERE id = 'r1'")
    .run(path);
  const report = await reconcileOperations(library);
  expect(report.operations).toMatchObject([
    { outcome: "retained", removed: [] },
  ]);
  expect(readFileSync(join(root, path))).toEqual(png);
  expect(book()?.cover_path).toBe(first.path);
  expect(
    (await reconcileOperations(library)).operations[0]?.previousState,
  ).toBe("failed");
  writeFileSync(join(root, "covers/orphan.png"), png);
  expect((await reconcileOperations(library)).unrecognized).toEqual([
    "covers/orphan.png",
  ]);
});

it("serves only a current approved cover inside the canonical covers directory", async () => {
  const added = await setManualCover(library, "b1", source, { normalize });
  const token = coverToken(added.path);
  expect(await readCover(library, "b1", token)).toEqual(png);
  expect(await readCover(library, "b1", "wrong")).toBeNull();
  expect(await readCover(library, "b1", "../catalog.sqlite")).toBeNull();
  const second = await setManualCover(library, "b1", source, { normalize });
  expect(await readCover(library, "b1", token)).toBeNull();
  rmSync(join(library.root, second.path));
  symlinkSync(source, join(library.root, second.path));
  expect(await readCover(library, "b1", coverToken(second.path))).toBeNull();
  rmSync(join(library.root, second.path));
  // An alias elsewhere inside the library is still outside covers/.
  const outsideCovers = join(library.root, "files", "not-a-cover.png");
  writeFileSync(outsideCovers, png);
  symlinkSync(outsideCovers, join(library.root, second.path));
  expect(await readCover(library, "b1", coverToken(second.path))).toBeNull();
  rmSync(join(library.root, second.path));
  writeFileSync(join(library.root, second.path), "unusable cover bytes");
  expect(await readCover(library, "b1", coverToken(second.path))).toBeNull();
  rmSync(join(library.root, second.path));
  expect(await readCover(library, "b1", coverToken(second.path))).toBeNull();
});

it("rejects byte and dimension bounds before calling the decoder", async () => {
  const bomb = Buffer.from(png);
  bomb.writeUInt32BE(100_000, 16);
  const cases = [
    Buffer.alloc(MAX_COVER_BYTES + 1),
    bomb,
    Buffer.from("not an image"),
  ];
  for (const bytes of cases) {
    writeFileSync(source, bytes);
    await expect(
      setManualCover(library, "b1", source, {
        normalize: () => {
          throw new Error("decoder must not run");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  }
  expect(book()?.cover_path).toBeNull();
  expect(readdirSync(join(library.root, "covers"))).toEqual([]);
});

it("handles truncated JPEG segments without an out-of-bounds read", () => {
  expect(() =>
    inspectCoverImage(Buffer.from([255, 216, 255, 255, 255, 255])),
  ).toThrow(/PNG or JPEG/);
});

it("retains a cover operation whose paths do not belong to its ID", async () => {
  const path = join(library.root, "staging/other-operation.partial");
  writeFileSync(path, "keep this uncertain file");
  library.database.exec(`INSERT INTO recovery_operations (id, kind, state, staged_path, created_at, updated_at)
    VALUES ('damaged', 'cover', 'pending', 'staging/other-operation.partial', 1, 1)`);
  expect((await reconcileOperations(library)).operations).toMatchObject([
    { outcome: "retained", removed: [] },
  ]);
  expect(readFileSync(path, "utf8")).toBe("keep this uncertain file");
});
