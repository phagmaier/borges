import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication, Page } from "@playwright/test";
import { catalog, openCatalogReader, stored, value } from "./catalog";
import { expect, test } from "./desktop";

test.use({
  catalog: { books: [{ fixture: "known.pdf", name: "Atlas.pdf" }] },
  environment: { BORGES_SAVE_INTERVAL_MS: "600000" },
});
const trash = (library: Page) =>
  library.getByRole("region", { name: "Trash contents" });
async function chooser(application: ElectronApplication, name: string) {
  await application.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    },
    resolve("tests/fixtures", name),
  );
}
async function showTrash(library: Page) {
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Trash", exact: true })
    .click();
}
async function replace(
  application: ElectronApplication,
  library: Page,
  id: string,
) {
  await chooser(application, "import-metadata.epub");
  await value(library, "replaceFile", id);
}

test("A10: current revision restore confirms, flushes/reloads an open reader, recovers its earlier position and retains organization/manual metadata", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, ui } = await openCatalogReader(application, "Atlas");
  const section = await value<{ id: string }>(
    library,
    "createSection",
    "Shelf",
    null,
  );
  await value(library, "addToSection", section.id, [id]);
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 3 of 3");
  const old = stored(profile, id).revision;
  await replace(application, library, id);
  await expect(ui.getByRole("status")).toHaveText("Ready");
  await value(library, "editMetadata", id, {
    title: "My Atlas",
    authors: ["Manual author"],
  });
  await value(library, "finish", id);
  await value(library, "archive", id);
  const displaced = stored(profile, id).revision;
  await showTrash(library);
  await trash(library)
    .getByRole("button", { name: "Restore as current…" })
    .click();
  await expect(library.getByRole("dialog")).toContainText(
    "displaced file in Trash",
  );
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(stored(profile, id).revision).toBe(displaced);
  await trash(library)
    .getByRole("button", { name: "Restore as current…" })
    .click();
  await library.screenshot({
    path: test.info().outputPath("restore-revision.png"),
  });
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(trash(library).getByRole("status")).toContainText(
    "Restored earlier revision",
  );
  await expect(ui.locator("#location")).toHaveText("Page 3 of 3");
  expect(stored(profile, id).revision).toBe(old);
  expect(
    catalog(
      profile,
      (db) =>
        db.prepare("SELECT revision_id FROM trash_entries").get()?.revision_id,
    ),
  ).toBe(displaced);
  expect(
    catalog(profile, (db) =>
      db
        .prepare("SELECT section_id FROM section_memberships WHERE book_id = ?")
        .all(id),
    ),
  ).toEqual([{ section_id: section.id }]);
  const books = await value<
    { title: string; authors: string[]; status: string; archived: boolean }[]
  >(library, "books", { view: { kind: "all" }, includeArchived: true });
  expect(books).toMatchObject([
    {
      title: "My Atlas",
      authors: ["Manual author"],
      status: "finished",
      archived: true,
    },
  ]);
});

test("A10: separate restoration creates an Unread entry, retains Trash, and a later restore conflict shows the live copy", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const library = await application.firstWindow();
  await replace(application, library, id);
  await value(library, "editMetadata", id, {
    title: "Manual title",
    authors: ["Manual author"],
  });
  await showTrash(library);
  await trash(library)
    .getByRole("button", { name: "Restore as separate book…" })
    .click();
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(trash(library).getByRole("status")).toContainText(
    "Restored separate Unread book “Atlas”",
  );
  const books = await value<{ id: string; title: string; status: string }[]>(
    library,
    "books",
    { view: { kind: "all" } },
  );
  const separate = books.find((b) => b.id !== id);
  expect(separate).toMatchObject({ title: "Atlas", status: "unread" });
  expect(stored(profile, separate?.id as string).page).toBeNull();
  const opened = application.waitForEvent("window");
  await trash(library)
    .getByRole("button", { name: "Restore as current…" })
    .click();
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(
    (await opened)
      .frameLocator('iframe[title="Book content"]')
      .getByRole("status"),
  ).toHaveText("Ready");
  await expect(trash(library).getByRole("alert")).toContainText(
    "Identical content is already live",
  );
  await expect(trash(library)).toContainText("1 entry");
});

test("A10: a Trash-only hash import restores the old revision in its open reader instead of silently importing or skipping", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, ui } = await openCatalogReader(application, "Atlas");
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
  const old = stored(profile, id).revision;
  await replace(application, library, id);
  await expect(ui.getByRole("status")).toHaveText("Ready");
  await chooser(application, "known.pdf");
  await library
    .getByRole("button", { name: "Import files…", exact: true })
    .click();
  const dialog = library.getByRole("dialog", {
    name: "Identical content in Trash",
  });
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await dialog.getByRole("radio").check();
  await dialog
    .getByRole("button", { name: "Restore as current", exact: true })
    .click();
  await expect(library.getByTestId("import-counts")).toHaveText(
    "1 restored/reused",
  );
  await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
  expect(stored(profile, id).revision).toBe(old);
  expect(
    catalog(
      profile,
      (db) => db.prepare("SELECT count(*) AS n FROM books").get()?.n,
    ),
  ).toBe(1);
});

test("Trash-only deleted-book import supports cancel, page reload cancellation, then restores the same entry", async ({
  application,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const library = await application.firstWindow();
  await value(library, "deleteBook", id);
  await chooser(application, "known.pdf");
  await library
    .getByRole("button", { name: "Import files…", exact: true })
    .click();
  const dialog = library.getByRole("dialog", {
    name: "Identical content in Trash",
  });
  await dialog.getByRole("button", { name: "Cancel this file" }).click();
  await expect(library.getByTestId("import-counts")).toHaveText("1 skipped");
  await library
    .getByRole("button", { name: "Import files…", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await library.reload();
  await expect(dialog).toHaveCount(0);
  await library
    .getByRole("button", { name: "Import files…", exact: true })
    .click();
  await dialog.getByRole("radio").check();
  await dialog
    .getByRole("button", { name: "Restore book", exact: true })
    .click();
  await expect(library.getByTestId("import-counts")).toHaveText(
    "1 restored/reused",
  );
  const books = await value<{ id: string }[]>(library, "books", {
    view: { kind: "all" },
  });
  expect(books.map((b) => b.id)).toEqual([id]);
  const stale = await library.evaluate(() =>
    window.borges.library.resolveTrashMatch("expired", { action: "cancel" }),
  );
  expect(stale.ok).toBe(false);
});

test("current restoration refuses failed saves and reports a committed reload failure without undoing the switch", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, ui } = await openCatalogReader(application, "Atlas");
  await replace(application, library, id);
  await expect(ui.getByRole("status")).toHaveText("Ready");
  const displaced = stored(profile, id).revision;
  const jump = ui.getByRole("textbox", { name: "Jump" });
  await jump.fill("60%");
  await jump.press("Enter");
  await showTrash(library);
  const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER refuse_restore_save BEFORE INSERT ON positions BEGIN SELECT RAISE(ABORT, 'cannot save position'); END",
    );
    await trash(library)
      .getByRole("button", { name: "Restore as current…" })
      .click();
    await library
      .getByRole("dialog")
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(trash(library).getByRole("alert")).toContainText(
      "position could not be saved",
    );
    expect(stored(profile, id).revision).toBe(displaced);
    db.exec("DROP TRIGGER refuse_restore_save");
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find((w) =>
        w.getTitle().includes("reader shell"),
      )?.webContents;
      if (!contents) throw new Error("no reader");
      contents.loadURL = async () => {
        throw new Error("injected reload failure");
      };
    });
    await trash(library)
      .getByRole("button", { name: "Restore as current…" })
      .click();
    await library
      .getByRole("dialog")
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(trash(library).getByRole("status")).toContainText(
      "reader could not reload",
    );
    expect(stored(profile, id).revision).not.toBe(displaced);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS refuse_restore_save");
    db.close();
  }
});
