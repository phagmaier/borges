import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import {
  bookButton,
  call,
  catalog,
  openCatalogReader,
  stored,
  value,
} from "./catalog";
import { expect, test } from "./desktop";

test.use({
  catalog: { books: [{ fixture: "known.pdf", name: "Atlas.pdf" }] },
  environment: { BORGES_SAVE_INTERVAL_MS: "600000" },
});
const trash = (library: Page) =>
  library.getByRole("region", { name: "Trash contents" });
async function move(library: Page) {
  await library
    .getByRole("region", { name: "Selected books" })
    .getByRole("button", { name: "Move to Trash…", exact: true })
    .click();
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
}
async function showTrash(library: Page) {
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Trash", exact: true })
    .click();
}

test("A10: deletion flushes and closes a reader; restore retains status, Archive, manual details, location and surviving sections", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, ui } = await openCatalogReader(application, "Atlas");
  const keep = await value<{ id: string }>(
    library,
    "createSection",
    "Kept",
    null,
  );
  const gone = await value<{ id: string }>(
    library,
    "createSection",
    "Gone",
    null,
  );
  await value(library, "addToSection", keep.id, [id]);
  await value(library, "addToSection", gone.id, [id]);
  await value(library, "editMetadata", id, {
    title: "My Atlas",
    authors: ["Ana"],
  });
  await value(library, "finish", id);
  await value(library, "archive", id);
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 3 of 3");
  expect(stored(profile, id).page).toBeNull();
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await library.getByRole("checkbox", { name: "Select My Atlas" }).check();
  await library
    .getByRole("button", { name: "Move to Trash…", exact: true })
    .click();
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(application.windows()).toHaveLength(2);
  const before = await readFile(resolve("tests/fixtures/known.pdf"));
  await move(library);
  await expect(library.getByRole("status")).toContainText(
    "Moved 1 book to Trash",
  );
  expect(application.windows()).toHaveLength(1);
  expect(stored(profile, id).page).toBe(3);
  await value(library, "deleteSection", gone.id);
  await showTrash(library);
  await expect(trash(library)).toContainText("My Atlas");
  await expect(trash(library)).toContainText("Finished · Archived · Page 3");
  await expect(trash(library)).toContainText("1 entry");
  await library.screenshot({ path: test.info().outputPath("trash-book.png") });
  await trash(library).getByRole("button", { name: "Restore book" }).click();
  await expect(trash(library).getByRole("status")).toContainText(
    "Restored “My Atlas” to Archive",
  );
  await expect(trash(library).getByRole("status")).toContainText(
    "Sections no longer available: Gone",
  );
  expect(
    catalog(profile, (db) =>
      db
        .prepare("SELECT section_id FROM section_memberships WHERE book_id = ?")
        .all(id),
    ),
  ).toEqual([{ section_id: keep.id }]);
  expect(await readFile(resolve("tests/fixtures/known.pdf"))).toEqual(before);
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  const opened = application.waitForEvent("window");
  await bookButton(library, "My Atlas").dblclick();
  const resumed = (await opened).frameLocator('iframe[title="Book content"]');
  await expect(resumed.locator("#location")).toHaveText("Page 3 of 3");
});

test("save, close and catalog failures explain refusal and leave the book live", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, ui } = await openCatalogReader(application, "Atlas");
  await library.getByRole("checkbox", { name: "Select Atlas" }).check();
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
  const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER refuse_save BEFORE INSERT ON positions BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await move(library);
    await expect(library.getByRole("alert")).toContainText(
      "position could not be saved",
    );
    expect(application.windows()).toHaveLength(2);
    expect(
      catalog(
        profile,
        (db) =>
          db.prepare("SELECT deleted_at FROM books WHERE id = ?").get(id)
            ?.deleted_at,
      ),
    ).toBeNull();
    db.exec("DROP TRIGGER refuse_save");
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.getTitle().includes("reader shell"),
      );
      if (!window) throw new Error("no reader");
      (globalThis as { restoreClose?: () => void }).restoreClose = () => {
        window.close = original;
      };
      const original = window.close.bind(window);
      window.close = () => {};
    });
    await move(library);
    await expect(library.getByRole("alert")).toContainText(
      "reader did not close",
    );
    await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
    expect(
      catalog(
        profile,
        (db) =>
          db.prepare("SELECT deleted_at FROM books WHERE id = ?").get(id)
            ?.deleted_at,
      ),
    ).toBeNull();
    await application.evaluate(() =>
      (globalThis as { restoreClose?: () => void }).restoreClose?.(),
    );
    db.exec(
      "CREATE TRIGGER refuse_delete BEFORE UPDATE OF deleted_at ON books BEGIN SELECT RAISE(ABORT, 'catalog full'); END",
    );
    await move(library);
    await expect(library.getByRole("alert")).toContainText("catalog full");
    expect(stored(profile, id).page).toBe(2);
    expect(
      catalog(
        profile,
        (db) =>
          db.prepare("SELECT deleted_at FROM books WHERE id = ?").get(id)
            ?.deleted_at,
      ),
    ).toBeNull();
    expect(
      catalog(
        profile,
        (db) => db.prepare("SELECT count(*) AS n FROM trash_entries").get()?.n,
      ),
    ).toBe(0);
  } finally {
    db.exec(
      "DROP TRIGGER IF EXISTS refuse_save; DROP TRIGGER IF EXISTS refuse_delete;",
    );
    db.close();
  }
});

test("Trash lists superseded files with saved positions and restores deleted books to Unfiled when all sections are gone", async ({
  application,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, ui } = await openCatalogReader(application, "Atlas");
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, resolve("tests/fixtures/import-metadata.epub"));
  await value(library, "replaceFile", id);
  await expect(ui.getByRole("status")).toHaveText("Ready");
  const section = await value<{ id: string }>(
    library,
    "createSection",
    "Old shelf",
    null,
  );
  await value(library, "addToSection", section.id, [id]);
  await library
    .getByRole("checkbox", { name: "Select Garden Stories" })
    .check();
  await move(library);
  await value(library, "deleteSection", section.id);
  await showTrash(library);
  await expect(trash(library)).toContainText("2 entries");
  await expect(
    trash(library).getByRole("region", { name: "Superseded files" }),
  ).toContainText("Saved position: Page 2");
  await trash(library).getByRole("button", { name: "Restore book" }).click();
  await expect(trash(library).getByRole("status")).toContainText(
    "The book is in Unfiled",
  );
  await expect(trash(library)).toContainText("1 entry");
  const readerApi = await call(library, "restoreDeletedBook", "expired");
  expect(readerApi.ok).toBe(false);
});

test("a closing reader cannot reacquire a session or accept competing book changes", async ({
  application,
  profile,
  seeded,
}) => {
  const id = seeded.Atlas as string;
  const { library, reader } = await openCatalogReader(application, "Atlas");
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.getTitle().includes("reader shell"),
    );
    if (!window) throw new Error("no reader");
    window.close = () => {};
  });
  const deleting = call(library, "deleteBook", id);
  await expect.poll(() => stored(profile, id).generation).toBeGreaterThan(1);
  const [reopen, reread, permission] = await Promise.all([
    call(library, "openBook", id),
    call(library, "startRereading", id),
    reader.evaluate(async () => {
      try {
        await window.borges.reader.openBook();
        return true;
      } catch {
        return false;
      }
    }),
  ]);
  expect(reopen.ok).toBe(false);
  expect(reread.ok).toBe(false);
  expect(permission).toBe(false);
  expect((await deleting).ok).toBe(false);
  expect(
    catalog(
      profile,
      (db) =>
        db.prepare("SELECT deleted_at FROM books WHERE id = ?").get(id)
          ?.deleted_at,
    ),
  ).toBeNull();
});

test.describe("selected books", () => {
  test.use({
    catalog: {
      books: [
        { fixture: "known.pdf", name: "Atlas.pdf" },
        { fixture: "image-only.pdf", name: "Scan.pdf" },
      ],
    },
  });
  test("reports partial deletion and keeps the failed book live", async ({
    application,
    profile,
    seeded,
  }) => {
    const library = await application.firstWindow();
    await library.getByRole("checkbox", { name: "Select Atlas" }).check();
    await library.getByRole("checkbox", { name: "Select Scan" }).check();
    const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
    try {
      db.exec(
        `CREATE TRIGGER refuse_scan BEFORE UPDATE OF deleted_at ON books WHEN NEW.id = '${seeded.Scan}' BEGIN SELECT RAISE(ABORT, 'cannot delete scan'); END`,
      );
      await move(library);
      await expect(library.getByRole("alert")).toContainText(
        "Moved 1 book to Trash",
      );
      await expect(library.getByRole("alert")).toContainText(
        "Not deleted: Scan",
      );
      expect(
        catalog(profile, (db) =>
          db.prepare("SELECT title FROM books WHERE deleted_at IS NULL").all(),
        ),
      ).toEqual([{ title: "Scan" }]);
      await showTrash(library);
      await expect(trash(library)).toContainText("Atlas");
    } finally {
      db.exec("DROP TRIGGER refuse_scan");
      db.close();
    }
  });
});

test("a restore conflict opens the live entry and keeps its explanation visible after catalog refresh", async ({
  application,
  seeded,
}) => {
  const library = await application.firstWindow();
  await value(library, "deleteBook", seeded.Atlas);
  // Explicit separate restoration creates a live copy while retaining Trash.
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, resolve("tests/fixtures/known.pdf"));
  await library
    .getByRole("button", { name: "Import files…", exact: true })
    .click();
  const match = library.getByRole("dialog", {
    name: "Identical content in Trash",
  });
  await match.getByRole("radio").check();
  await match
    .getByRole("button", { name: "Use as separate Unread book" })
    .click();
  await expect(library.getByTestId("import-counts")).toHaveText(
    "1 restored/reused",
  );
  await showTrash(library);
  const opened = application.waitForEvent("window");
  await trash(library).getByRole("button", { name: "Restore book" }).click();
  const reader = await opened;
  await expect(
    reader.frameLocator('iframe[title="Book content"]').getByRole("status"),
  ).toHaveText("Ready");
  await value(library, "createSection", "Refresh", null);
  await expect(
    library.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeVisible();
  await expect(trash(library).getByRole("alert")).toContainText(
    "Identical content is already live",
  );
  await expect(
    trash(library).getByRole("button", { name: "Restore book" }),
  ).toBeVisible();
});
