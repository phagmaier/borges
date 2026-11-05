import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { catalog, openCatalogReader, stored, value } from "./catalog";
import { expect, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "First.pdf" },
      { fixture: "image-only.pdf", name: "Second.pdf" },
    ],
  },
  environment: { BORGES_SAVE_INTERVAL_MS: "600000" },
});

async function prepare(library: Page, ids: Record<string, string>) {
  for (const id of Object.values(ids))
    await value(library, "editMetadata", id, {
      title: "Garden Stories",
      authors: ["Zora"],
    });
  await value(library, "archive", ids.Second);
}
async function start(application: ElectronApplication, library: Page) {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, resolve("tests/fixtures/import-metadata.epub"));
  await library
    .getByRole("button", { name: "Import files…", exact: true })
    .click();
}
const summary = (library: Page) =>
  library.getByRole("region", { name: "Import summary" });

test("A8: shows every candidate, Keep Both adds a separate section member and identical reimport skips without a metadata prompt", async ({
  application,
  profile,
  seeded,
}) => {
  const library = await application.firstWindow();
  await prepare(library, seeded);
  const section = await value<{ id: string }>(
    library,
    "createSection",
    "New shelf",
    null,
  );
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: /New shelf/ })
    .click();
  const before = await readFile(resolve("tests/fixtures/import-metadata.epub"));
  await start(application, library);
  const dialog = library.getByRole("dialog");
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await expect(dialog).toContainText("(archived)");
  await expect(
    dialog.getByRole("button", { name: "Replace selected" }),
  ).toBeDisabled();
  await library.screenshot({
    path: test.info().outputPath("metadata-choice.png"),
  });
  await dialog.getByRole("button", { name: "Keep Both", exact: true }).click();
  await expect(summary(library)).toContainText("1 imported");
  expect(
    catalog(
      profile,
      (db) => db.prepare("SELECT count(*) AS n FROM books").get()?.n,
    ),
  ).toBe(3);
  expect(
    catalog(
      profile,
      (db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM section_memberships WHERE section_id = ?",
          )
          .get(section.id)?.n,
    ),
  ).toBe(1);
  await start(application, library);
  await expect(summary(library)).toContainText("1 skipped");
  await expect(library.getByRole("dialog")).toHaveCount(0);
  expect(
    await readFile(resolve("tests/fixtures/import-metadata.epub")),
  ).toEqual(before);
});

test("A8: replaces only the selected open reader and retains its flushed old position in Trash", async ({
  application,
  profile,
  seeded,
}) => {
  const { library, reader, ui } = await openCatalogReader(application, "First");
  await prepare(library, seeded);
  const old = stored(profile, seeded.First as string);
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
  await start(application, library);
  const dialog = library.getByRole("dialog");
  await dialog.getByRole("radio", { name: /First.pdf/ }).check();
  await dialog.getByRole("button", { name: "Replace selected" }).click();
  await expect(summary(library)).toContainText("Replaced file");
  await expect(ui.getByTestId("visible-text")).toContainText(
    "ORCHID EPUB FIRST",
  );
  await expect(reader.locator("h1")).toHaveText("Garden Stories");
  expect(stored(profile, seeded.First as string).revision).not.toBe(
    old.revision,
  );
  expect(
    catalog(
      profile,
      (db) =>
        db
          .prepare("SELECT pdf_page FROM positions WHERE revision_id = ?")
          .get(old.revision)?.pdf_page,
    ),
  ).toBe(2);
  expect(
    catalog(
      profile,
      (db) =>
        db.prepare("SELECT revision_id FROM trash_entries").get()?.revision_id,
    ),
  ).toBe(old.revision);
  expect(
    catalog(
      profile,
      (db) => db.prepare("SELECT count(*) AS n FROM books").get()?.n,
    ),
  ).toBe(2);
});

test("A8: Skip and Cancel make no catalog change, and stale prompt replies are refused", async ({
  application,
  profile,
  seeded,
}) => {
  const library = await application.firstWindow();
  await prepare(library, seeded);
  await start(application, library);
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Skip", exact: true })
    .click();
  await expect(summary(library)).toContainText("1 skipped");
  await start(application, library);
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel import", exact: true })
    .click();
  await expect(summary(library)).toContainText("1 cancelled");
  expect(
    catalog(
      profile,
      (db) => db.prepare("SELECT count(*) AS n FROM books").get()?.n,
    ),
  ).toBe(2);
  const reply = await library.evaluate(() =>
    window.borges.library.resolveDuplicate("expired", { action: "keep-both" }),
  );
  expect(reply.ok).toBe(false);
});

test("reloading a pending metadata prompt cancels its staged copy and releases the next batch", async ({
  application,
  profile,
  seeded,
}) => {
  const library = await application.firstWindow();
  await prepare(library, seeded);
  await start(application, library);
  await expect(library.getByRole("dialog")).toBeVisible();
  await library.reload();
  await expect(library.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      catalog(
        profile,
        (db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM recovery_operations WHERE state NOT IN ('committed', 'abandoned')",
            )
            .get()?.n,
      ),
    )
    .toBe(0);
  await start(application, library);
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Skip", exact: true })
    .click();
  await expect(summary(library)).toContainText("1 skipped");
  expect(
    catalog(
      profile,
      (db) => db.prepare("SELECT count(*) AS n FROM books").get()?.n,
    ),
  ).toBe(2);
});
