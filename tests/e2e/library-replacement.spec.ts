import { readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication, Page } from "@playwright/test";
import { call, catalog, openCatalogReader, stored, value } from "./catalog";
import { expect, launch, test } from "./desktop";

// Native chooser results are supplied at the dialog boundary. Validation,
// copying, sessions, SQLite, reader reloads and source-preservation checks are real.
test.use({
  catalog: { books: [{ fixture: "known.pdf", name: "Atlas.pdf" }] },
  environment: { BORGES_SAVE_INTERVAL_MS: "600000" },
});
const fixture = (name: string) => resolve("tests/fixtures", name);
const bar = (library: Page) =>
  library.getByRole("region", { name: "Selected books" });
async function chooser(application: ElectronApplication, name: string | null) {
  await application.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: !path,
        filePaths: path ? [path] : [],
      })) as typeof dialog.showOpenDialog;
    },
    name ? fixture(name) : null,
  );
}
async function replace(library: Page) {
  await bar(library)
    .getByRole("button", { name: "Replace File…", exact: true })
    .click();
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Choose replacement…" })
    .click();
}
const revision = (profile: string, id: string) =>
  catalog(
    profile,
    (db) =>
      db
        .prepare(
          "SELECT current_revision_id AS revision FROM books WHERE id = ?",
        )
        .get(id)?.revision,
  );

test("A9: replaces an open PDF with an EPUB, flushes the old position, preserves book state and rejects late writes across restart", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, reader, ui } = await openCatalogReader(application, "Atlas");
  const old = stored(profile, id);
  const section = await value<{ id: string }>(
    library,
    "createSection",
    "Shelf",
    null,
  );
  await value(library, "addToSection", section.id, [id]);
  await value(library, "editMetadata", id, { title: "My Atlas", authors: [] });
  await value(library, "finish", id);
  await value(library, "archive", id);
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await library.getByRole("checkbox", { name: "Select My Atlas" }).check();
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 3 of 3");
  // The deliberately long interval means replacement, not autosave, must flush.
  expect(stored(profile, id).page).toBeNull();
  await bar(library).getByRole("button", { name: "Replace File…" }).click();
  await expect(library.getByRole("dialog")).toContainText(
    "previous file and saved position stay in Trash",
  );
  await library.screenshot({
    path: test.info().outputPath("replace-confirmation.png"),
  });
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  expect(revision(profile, id)).toBe(old.revision);
  const sourceBefore = await readFile(fixture("import-metadata.epub"));
  await chooser(application, "import-metadata.epub");
  await replace(library);
  await expect(library.getByRole("status")).toHaveText(
    "Replaced file for My Atlas. Previous file and position kept in Trash.",
  );
  await expect(ui.getByRole("status")).toHaveText("Ready");
  await expect(ui.locator("#location")).toContainText("Chapter 1 ·");
  await expect(reader.locator("h1")).toHaveText("My Atlas");
  await expect(ui.getByTestId("visible-text")).toContainText(
    "ORCHID EPUB FIRST",
  );
  await library.screenshot({
    path: test.info().outputPath("replacement-complete.png"),
  });
  const current = stored(profile, id);
  expect(current.revision).not.toBe(old.revision);
  expect(current.generation).toBeGreaterThan(old.generation);
  expect(current.cfi).toBeNull(); // new position pending, old locator never reused
  expect(
    catalog(profile, (db) =>
      db
        .prepare("SELECT pdf_page FROM positions WHERE revision_id = ?")
        .get(old.revision),
    ),
  ).toEqual({ pdf_page: 3 });
  expect(
    catalog(profile, (db) =>
      db.prepare("SELECT revision_id FROM trash_entries").get(),
    ),
  ).toEqual({ revision_id: old.revision });
  expect(
    await value(library, "books", { view: { kind: "archive" } }),
  ).toMatchObject([
    {
      id,
      title: "My Atlas",
      authors: [],
      subjects: ["Fiction", "Gardens"],
      status: "finished",
      archived: true,
      sectionIds: [section.id],
      format: "epub",
      coverToken: expect.any(String),
    },
  ]);
  const rejected = await reader.evaluate(
    async (old) => {
      return new Promise((resolve) => {
        const off = window.borges.reader.onProgressResult((result) => {
          if (result.generation === old.generation && result.sequence === 999) {
            off();
            resolve(result);
          }
        });
        window.borges.reader.reportProgress({
          bookId: old.bookId,
          revisionId: old.revision,
          generation: old.generation,
          sequence: 999,
          location: { format: "pdf", page: 2, x: 0, y: 0 },
          sizing: { fontSize: 16, zoom: 1 },
        });
      });
    },
    { ...old, bookId: id },
  );
  expect(rejected).toMatchObject({ ok: false, code: "stale-session" });
  expect(await call(reader, "replaceFile", id)).toMatchObject({
    ok: false,
    thrown: expect.stringContaining("Only the library window"),
  });
  expect(await readFile(fixture("import-metadata.epub"))).toEqual(sourceBefore);
  const oldPath = catalog(
    profile,
    (db) =>
      db.prepare("SELECT path FROM revisions WHERE id = ?").get(old.revision)
        ?.path,
  );
  expect(await readFile(join(profile, "library", String(oldPath)))).toEqual(
    await readFile(fixture("known.pdf")),
  );
  await application.close();
  const restarted = await launch(profile);
  try {
    const nextLibrary = await restarted.firstWindow();
    await expect(nextLibrary.locator(".result-count")).toHaveText("0 books");
    const nextWindow = restarted.waitForEvent("window");
    await value(nextLibrary, "openBook", id);
    const nextReader = await nextWindow;
    await expect(
      nextReader
        .frameLocator('iframe[title="Book content"]')
        .getByRole("status"),
    ).toHaveText("Ready");
    expect(revision(profile, id)).toBe(current.revision);
    expect(
      catalog(profile, (db) =>
        db.prepare("SELECT count(*) AS n FROM trash_entries").get(),
      ),
    ).toEqual({ n: 1 });
  } finally {
    await restarted.close();
  }
});

test("validates replacements before touching a closed book, handles chooser cancellation, and refreshes metadata with fallbacks", async ({
  application,
  profile,
  seeded,
}) => {
  const library = await application.firstWindow();
  const id = seeded.Atlas as string;
  await expect(library.locator(".result-count")).toHaveText("1 book");
  await library.getByRole("checkbox", { name: "Select Atlas" }).check();
  const old = revision(profile, id);
  for (const [name, reason] of [
    [null, "Replacement cancelled."],
    ["import-password.pdf", "Encrypted PDFs are not supported"],
    ["import-drm.epub", "DRM-protected EPUB"],
    ["import-corrupt.pdf", "could not be parsed"],
  ] as const) {
    await chooser(application, name);
    await replace(library);
    await expect(
      library.getByRole(name === null ? "status" : "alert"),
    ).toContainText(reason);
    expect(revision(profile, id)).toBe(old);
    expect(
      catalog(profile, (db) =>
        db.prepare("SELECT count(*) AS n FROM trash_entries").get(),
      ),
    ).toEqual({ n: 0 });
  }
  await chooser(application, "import-metadata.epub");
  await replace(library);
  await expect(library.getByRole("status")).toContainText(
    "Replaced file for Garden Stories.",
  );
  await expect(
    library.getByRole("checkbox", { name: "Select Garden Stories" }),
  ).toBeChecked();
  const epubRevision = revision(profile, id);
  await chooser(application, "import-metadata.pdf");
  await replace(library);
  await expect(library.getByRole("status")).toContainText(
    "Replaced file for Garden Atlas.",
  );
  expect(await value(library, "books")).toMatchObject([
    {
      id,
      title: "Garden Atlas",
      authors: ["Zora", "Ana"],
      subjects: ["Maps", "Travel"],
      status: "unread",
      format: "pdf",
    },
  ]);
  expect(
    catalog(profile, (db) =>
      db
        .prepare("SELECT revision_id FROM trash_entries ORDER BY trashed_at")
        .all(),
    ),
  ).toEqual([{ revision_id: old }, { revision_id: epubRevision }]);
  const cover = catalog(
    profile,
    (db) =>
      db.prepare("SELECT cover_path FROM books WHERE id = ?").get(id)
        ?.cover_path,
  );
  await chooser(application, "import-no-metadata.epub");
  await replace(library);
  await expect(library.getByRole("status")).toContainText(
    "Replaced file for Garden Atlas.",
  );
  expect(await value(library, "books")).toMatchObject([
    {
      id,
      title: "Garden Atlas",
      authors: ["Zora", "Ana"],
      subjects: ["Maps", "Travel"],
      format: "epub",
    },
  ]);
  expect(
    catalog(
      profile,
      (db) =>
        db.prepare("SELECT cover_path FROM books WHERE id = ?").get(id)
          ?.cover_path,
    ),
  ).toBe(cover);
});

test("failed saves and failed commits keep the old reader usable; a reload failure after commit reports success with a reader warning", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, reader, ui } = await openCatalogReader(application, "Atlas");
  await library.getByRole("checkbox", { name: "Select Atlas" }).check();
  const old = stored(profile, id);
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
  const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER fail_save BEFORE INSERT ON positions BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await chooser(application, "import-metadata.epub");
    await replace(library);
    await expect(library.getByRole("alert")).toContainText(
      "position could not be saved",
    );
    expect(revision(profile, id)).toBe(old.revision);
    expect(stored(profile, id).generation).toBe(old.generation);
    await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
    db.exec("DROP TRIGGER fail_save");
    db.exec(
      "CREATE TRIGGER fail_switch BEFORE UPDATE OF current_revision_id ON books BEGIN SELECT RAISE(ABORT, 'catalog full'); END",
    );
    await replace(library);
    await expect(library.getByRole("alert")).toContainText("catalog full");
    await expect(ui.getByRole("status")).toHaveText("Ready");
    await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
    expect(stored(profile, id).page).toBe(2);
    expect(revision(profile, id)).toBe(old.revision);
    db.exec("DROP TRIGGER fail_switch");
    // Fail only the post-commit reload of the existing reader shell.
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find((w) =>
        w.getTitle().includes("reader shell"),
      )?.webContents;
      if (!contents) throw new Error("no reader");
      contents.loadURL = async () => {
        throw new Error("injected reader reload failure");
      };
    });
    await replace(library);
    await expect(library.getByRole("status")).toContainText(
      "Replaced file for Garden Stories.",
    );
    await expect(library.getByRole("status")).toContainText(
      "reader could not reload",
    );
    expect(revision(profile, id)).not.toBe(old.revision);
    expect(
      catalog(profile, (db) =>
        db.prepare("SELECT revision_id FROM trash_entries").get(),
      ),
    ).toEqual({ revision_id: old.revision });
    expect(
      catalog(profile, (db) =>
        db
          .prepare("SELECT pdf_page FROM positions WHERE revision_id = ?")
          .get(old.revision),
      ),
    ).toEqual({ pdf_page: 2 });
    await expect(reader.locator("h1")).toHaveText("Atlas"); // reload failure leaves the retired page
  } finally {
    db.exec(
      "DROP TRIGGER IF EXISTS fail_save; DROP TRIGGER IF EXISTS fail_switch",
    );
    db.close();
  }
});

test("a library reload cancels a pending chooser, and import/replacement requests cannot overlap", async ({
  application,
  profile,
  seeded,
}) => {
  const library = await application.firstWindow();
  const id = seeded.Atlas as string;
  await expect(library.locator(".result-count")).toHaveText("1 book");
  const old = revision(profile, id);
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (() =>
      new Promise((resolve) => {
        (
          globalThis as {
            finishReplacementChoice?: (choice: {
              canceled: boolean;
              filePaths: string[];
            }) => void;
          }
        ).finishReplacementChoice = resolve;
      })) as typeof dialog.showOpenDialog;
  });
  await library.getByRole("checkbox", { name: "Select Atlas" }).check();
  await replace(library);
  await expect(
    bar(library).getByRole("button", { name: "Replacing file…" }),
  ).toBeDisabled();
  expect(await call(library, "replaceFile", id)).toMatchObject({
    ok: false,
    code: "invalid",
  });
  expect(await call(library, "importBooks", "files", null)).toMatchObject({
    ok: false,
    code: "invalid",
  });
  await library.reload();
  await expect(library.locator(".result-count")).toHaveText("1 book");
  await application.evaluate((_, path) => {
    (
      globalThis as {
        finishReplacementChoice?: (choice: {
          canceled: boolean;
          filePaths: string[];
        }) => void;
      }
    ).finishReplacementChoice?.({ canceled: false, filePaths: [path] });
  }, fixture("import-metadata.epub"));
  await chooser(application, null);
  // A new request succeeds after the abandoned page's chooser has settled.
  await expect
    .poll(async () => (await call(library, "replaceFile", id)).ok)
    .toBe(true);
  expect(revision(profile, id)).toBe(old);
  expect(
    catalog(profile, (db) =>
      db.prepare("SELECT count(*) AS n FROM trash_entries").get(),
    ),
  ).toEqual({ n: 0 });
});

test("Replace File repairs a missing managed copy from its byte-identical original and reloads the failed reader", async ({
  application,
  profile,
  seeded,
}) => {
  const library = await application.firstWindow();
  const id = seeded.Atlas as string;
  await expect(library.locator(".result-count")).toHaveText("1 book");
  const old = revision(profile, id);
  const path = catalog(
    profile,
    (db) =>
      db.prepare("SELECT path FROM revisions WHERE id = ?").get(String(old))
        ?.path,
  );
  await unlink(join(profile, "library", String(path)));
  const opened = application.waitForEvent("window");
  await value(library, "openBook", id);
  const reader = await opened;
  await expect(reader.getByRole("alert")).toContainText(
    "could not be read from the library",
  );
  await library.getByRole("checkbox", { name: "Select Atlas" }).check();
  await chooser(application, "known.pdf");
  await replace(library);
  await expect(library.getByRole("status")).toContainText(
    "Replaced file for Atlas.",
  );
  await expect(
    reader
      .frameLocator('iframe[title="Book content"]')
      .getByTestId("page-text"),
  ).toContainText("ORCHID FIRST");
  expect(revision(profile, id)).not.toBe(old);
  expect(
    catalog(profile, (db) =>
      db.prepare("SELECT revision_id FROM trash_entries").get(),
    ),
  ).toEqual({ revision_id: old });
});
