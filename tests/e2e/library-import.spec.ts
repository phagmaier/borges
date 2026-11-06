import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { bookButton, call, catalog, openCatalogReader, value } from "./catalog";
import { expect, test } from "./desktop";

// M4-01: importing files and folders through the library window. The native
// file chooser is stubbed at its result boundary; everything after it (walk,
// copy, validation, publication, catalog commit, UI) is real.

const fixture = (name: string) => resolve("tests/fixtures", name);

/** Answer the next file choosers with `paths`, recording what was asked. */
async function chooser(application: ElectronApplication, paths: string[]) {
  await application.evaluate(({ dialog }, paths) => {
    const calls: unknown[] = [];
    (globalThis as { chooserCalls?: unknown[] }).chooserCalls = calls;
    dialog.showOpenDialog = (async (_: unknown, options: unknown) => {
      calls.push(options);
      return { canceled: false, filePaths: paths };
    }) as typeof dialog.showOpenDialog;
  }, paths);
}
const chooserCalls = (application: ElectronApplication) =>
  application.evaluate(
    () =>
      (globalThis as { chooserCalls?: { properties: string[] }[] })
        .chooserCalls ?? [],
  );

async function digests(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    result[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return result;
}

const summary = (library: Page) =>
  library.getByRole("region", { name: "Import summary", includeHidden: true });
const titles = (profile: string) =>
  catalog(profile, (db) =>
    db
      .prepare("SELECT title FROM books ORDER BY title")
      .all()
      .map((row) => row.title),
  );
const managed = async (profile: string, directory: string) =>
  (await readdir(join(profile, "library", directory))).length;

test("imports a mixed folder, skips identical content with a way to show it, and joins a selected section", async ({
  application,
  profile,
}) => {
  const library = await application.firstWindow();
  await expect(library.locator(".result-count")).toHaveText("0 books");
  await expect(library.getByText(/Use Import files…/)).toBeVisible();

  const shelf = join(profile, "Shelf");
  await mkdir(join(shelf, "Nested"), { recursive: true });
  await copyFile(fixture("known.pdf"), join(shelf, "Atlas.pdf"));
  await copyFile(fixture("fixed.epub"), join(shelf, "Nested", "Plates.epub"));
  await copyFile(fixture("image-only.pdf"), join(shelf, "Scan.pdf"));
  await writeFile(join(shelf, "Fake.pdf"), "Plain text, not a PDF.\n");
  await writeFile(join(shelf, "notes.txt"), "Shopping list\n");
  const before = await digests(shelf);

  await chooser(application, [shelf]);
  await library.getByRole("button", { name: "Import folder…" }).click();
  await expect(summary(library).getByTestId("import-counts")).toHaveText(
    "2 unsupported · 3 imported",
  );
  expect((await chooserCalls(application))[0]?.properties).toEqual([
    "openDirectory",
    "multiSelections",
  ]);
  await expect(
    summary(library).getByRole("list", { name: "Unsupported" }),
  ).toContainText("Fake.pdf does not contain PDF data.");
  await expect(summary(library)).toContainText("New books are in Unfiled.");
  await expect(library.locator(".result-count")).toHaveText("3 books");
  for (const title of ["Atlas", "Borges known fixture", "Scan"])
    await expect(bookButton(library, title)).toBeVisible();
  expect(titles(profile)).toEqual(["Atlas", "Borges known fixture", "Scan"]);
  expect(await digests(shelf)).toEqual(before);
  expect(await managed(profile, "staging")).toBe(0);

  // Imported bytes render in real readers (PDF and image-rich EPUB).
  const pdf = await openCatalogReader(application, "Atlas");
  await expect(pdf.ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  const epub = await openCatalogReader(application, "Borges known fixture");
  await expect
    .poll(
      () =>
        epub.reader
          .frames()
          .filter((frame) => frame.url().startsWith("blob:borges://reader-"))
          .length,
    )
    .toBe(1);
  const chapter = epub.reader
    .frames()
    .find((frame) => frame.url().startsWith("blob:borges://reader-"));
  if (!chapter) throw new Error("No chapter frame");
  await expect(chapter.locator("body")).toContainText("ORCHID EPUB FIRST");
  const image = chapter.getByAltText("Coral square");
  await expect(image).toBeVisible();
  expect(
    await image.evaluate(
      (img: HTMLImageElement) => img.complete && img.naturalWidth === 24,
    ),
  ).toBe(true);
  // Readers cannot start or cancel imports.
  for (const [method, args] of [
    ["importBooks", ["files", null]],
    ["cancelImport", []],
  ] as const)
    expect(await call(pdf.reader, method, ...args)).toMatchObject({
      ok: false,
      thrown: expect.stringContaining("Only the library window may do this."),
    });

  // Identical bytes under another name, archived meanwhile: skipped, shown.
  const atlasId = catalog(
    profile,
    (db) => db.prepare("SELECT id FROM books WHERE title = 'Atlas'").get()?.id,
  );
  await value(library, "archive", atlasId);
  const copy = join(profile, "Atlas copy.pdf");
  await copyFile(fixture("known.pdf"), copy);
  await library.getByRole("button", { name: "Dismiss" }).click();
  await chooser(application, [copy]);
  await library.getByRole("button", { name: "Import files…" }).click();
  await expect(summary(library).getByTestId("import-counts")).toHaveText(
    "1 skipped",
  );
  expect((await chooserCalls(application))[0]?.properties).toEqual([
    "openFile",
    "multiSelections",
  ]);
  await expect(summary(library)).toContainText(
    "Atlas copy.pdf is already in the library as “Atlas” (archived); it was skipped.",
  );
  await summary(library).getByRole("button", { name: "Show “Atlas”" }).click();
  await expect(library.getByRole("heading", { level: 1 })).toHaveText(
    "Archive",
  );
  await expect(library.getByRole("searchbox")).toHaveValue("Atlas");
  await expect(bookButton(library, "Atlas")).toBeVisible();
  expect(titles(profile)).toEqual(["Atlas", "Borges known fixture", "Scan"]);

  // From a selected section, new books join it in the same commit.
  await library.getByRole("searchbox").fill("");
  const maps = await value<{ id: string }>(
    library,
    "createSection",
    "Maps",
    null,
  );
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Maps", exact: true })
    .click();
  const story = join(profile, "Story.epub");
  await copyFile(fixture("reflowable.epub"), story);
  await chooser(application, [story]);
  await library.getByRole("button", { name: "Import files…" }).click();
  await expect(summary(library)).toContainText("New books joined Maps.");
  await expect(summary(library)).toBeHidden();
  await expect(library.locator(".result-count")).toHaveText("1 book");
  await expect(bookButton(library, "Borges known fixture")).toBeVisible();
  expect(
    catalog(profile, (db) =>
      db
        .prepare(
          "SELECT b.title FROM section_memberships m JOIN books b ON b.id = m.book_id WHERE m.section_id = ?",
        )
        .all(maps.id)
        .map((row) => row.title),
    ),
  ).toEqual(["Borges known fixture"]);
});

test.describe("slow copies", () => {
  // 200 ms after each 256 KiB chunk: each 1.5 MiB file takes over a second.
  test.use({ environment: { BORGES_IMPORT_CHUNK_DELAY_MS: "200" } });

  test("Cancel keeps completed books and rolls back the current copy; reloading the library cancels too", async ({
    application,
    profile,
  }) => {
    const library = await application.firstWindow();
    await expect(library.locator(".result-count")).toHaveText("0 books");
    const folder = join(profile, "Large");
    await mkdir(folder);
    for (const name of ["A", "B", "C", "D", "E"])
      await writeFile(
        join(folder, `${name}.pdf`),
        Buffer.concat([
          await readFile(fixture("known.pdf")),
          Buffer.from(`\n% ${name}\n`),
          Buffer.alloc(1536 * 1024, name.charCodeAt(0)),
        ]),
      );
    await chooser(application, [folder]);
    await library.getByRole("button", { name: "Import folder…" }).click();
    await expect(
      library
        .getByRole("region", { name: "Import", exact: true })
        .getByRole("status"),
    ).toHaveText("Importing 2 of 5: Large/B.pdf");
    await library.getByRole("button", { name: "Cancel import" }).click();
    await expect(summary(library).getByRole("heading")).toHaveText(
      "Import cancelled",
    );
    await expect(summary(library).getByTestId("import-counts")).toHaveText(
      "4 cancelled · 1 imported",
    );
    await expect(
      summary(library).getByRole("list", { name: "Cancelled" }),
    ).toContainText(
      "Cancelled during import; no book was created for Large/B.pdf.",
    );
    expect(titles(profile)).toEqual(["A"]);
    expect(await managed(profile, "files")).toBe(1);
    expect(await managed(profile, "staging")).toBe(0);

    // Reloading the window that started a batch cancels it in main.
    await library.getByRole("button", { name: "Dismiss" }).click();
    await chooser(application, [join(folder, "D.pdf"), join(folder, "E.pdf")]);
    await library.getByRole("button", { name: "Import files…" }).click();
    await expect(
      library
        .getByRole("region", { name: "Import", exact: true })
        .getByRole("status"),
    ).toHaveText("Importing 1 of 2: D.pdf");
    await library.reload();
    await expect
      .poll(() =>
        catalog(profile, (db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM recovery_operations WHERE state NOT IN ('committed', 'abandoned')",
            )
            .get(),
        ),
      )
      .toEqual({ n: 0 });
    await expect
      .poll(() => managed(profile, "staging"), { timeout: 10_000 })
      .toBe(0);
    expect(titles(profile)).toEqual(["A"]);
    // A reload while the chooser is still open: the late answer starts nothing.
    await application.evaluate(
      ({ dialog }, path) => {
        const state = globalThis as { answered?: boolean };
        state.answered = false;
        dialog.showOpenDialog = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          state.answered = true;
          return { canceled: false, filePaths: [path] };
        }) as typeof dialog.showOpenDialog;
      },
      join(folder, "E.pdf"),
    );
    await library.getByRole("button", { name: "Import files…" }).click();
    await library.reload();
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as { answered?: boolean }).answered,
        ),
      )
      .toBe(true);
    // A new batch can start once the cancelled one has stopped.
    await chooser(application, [join(folder, "C.pdf")]);
    await library.getByRole("button", { name: "Import files…" }).click();
    await expect(summary(library).getByTestId("import-counts")).toHaveText(
      "1 imported",
    );
    expect(titles(profile)).toEqual(["A", "C"]);
    expect(await managed(profile, "files")).toBe(2);
  });
});
