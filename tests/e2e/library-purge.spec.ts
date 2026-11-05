import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TrashListing } from "../../src/library/trash";
import { call, catalog, openCatalogReader, value } from "./catalog";
import { expect, launch, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Atlas.pdf" },
      { fixture: "image-only.pdf", name: "Scan.pdf" },
    ],
  },
});

async function showTrash(library: import("@playwright/test").Page) {
  await library
    .getByRole("navigation", { name: "Library" })
    .getByRole("button", { name: "Trash", exact: true })
    .click();
  return library.getByRole("region", { name: "Trash contents" });
}

test("A10: confirmation shows count/storage, Cancel preserves bytes, and purge preserves an open current revision and sources", async ({
  application,
  seeded,
  profile,
}) => {
  const sourceBefore = await readFile(resolve("tests/fixtures/known.pdf"));
  const { library, reader, ui } = await openCatalogReader(application, "Atlas");
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, resolve("tests/fixtures/import-metadata.epub"));
  await value(library, "replaceFile", seeded.Atlas);
  await expect(ui.getByRole("status")).toHaveText("Ready");
  await value(library, "deleteBook", seeded.Scan);
  const trash = await showTrash(library);
  await expect(trash).toContainText("2 entries");
  const before = await readdir(join(profile, "library/files"));
  await trash
    .getByRole("button", { name: "Empty Trash…", exact: true })
    .click();
  const confirm = library.getByRole("dialog", {
    name: "Permanently empty Trash?",
  });
  await expect(confirm).toContainText("2 entries");
  await expect(confirm).toContainText(/KiB| B/);
  await expect(confirm).toContainText("cannot be restored");
  await library.screenshot({
    path: test.info().outputPath("empty-trash-confirmation.png"),
  });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await readdir(join(profile, "library/files"))).toEqual(before);
  await trash
    .getByRole("button", { name: "Empty Trash…", exact: true })
    .click();
  await confirm
    .getByRole("button", { name: "Empty Trash permanently", exact: true })
    .click();
  await expect(trash).toContainText("Trash is empty.");
  expect(await readdir(join(profile, "library/files"))).toHaveLength(1);
  await expect(ui.getByRole("status")).toHaveText("Ready");
  await ui.getByRole("region", { name: "Reading surface" }).focus();
  await ui.getByRole("region", { name: "Reading surface" }).press("ArrowRight");
  await expect(ui.locator("#location")).not.toHaveText("");
  expect(await readFile(resolve("tests/fixtures/known.pdf"))).toEqual(
    sourceBefore,
  );
  expect(
    catalog(profile, (db) => db.prepare("PRAGMA foreign_key_check").all()),
  ).toEqual([]);
  const readerDenied = await reader.evaluate(async () => {
    try {
      await window.borges.library.emptyTrash([], 0);
      return false;
    } catch {
      return true;
    }
  });
  expect(readerDenied).toBe(true);
});

test("partial purge failures survive refresh, prevent restoration and remain retryable", async ({
  application,
  seeded,
  profile,
}) => {
  const library = await application.firstWindow();
  await value(library, "deleteBook", seeded.Atlas);
  await value(library, "deleteBook", seeded.Scan);
  const path = catalog(
    profile,
    (db) =>
      db
        .prepare("SELECT r.path FROM revisions r WHERE book_id = ?")
        .get(seeded.Atlas as string)?.path,
  ) as string;
  const original = await readFile(join(profile, "library", path));
  await writeFile(join(profile, "library", path), "MODIFIED BY FAILURE TEST");
  const trash = await showTrash(library);
  await trash
    .getByRole("button", { name: "Empty Trash…", exact: true })
    .click();
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Empty Trash permanently" })
    .click();
  await expect(trash.getByRole("status")).toHaveText(
    "Permanently removed 1 Trash entry.",
  );
  await expect(trash.getByRole("alert").first()).toContainText(
    "recorded content",
  );
  await library.reload();
  await showTrash(library);
  await expect(trash.getByRole("alert")).toContainText("recorded content");
  await expect(
    trash.getByRole("button", { name: "Restore book" }),
  ).toBeDisabled();
  await writeFile(join(profile, "library", path), original);
  await library.reload();
  await showTrash(library);
  await trash
    .getByRole("button", { name: "Empty Trash…", exact: true })
    .click();
  await library
    .getByRole("dialog")
    .getByRole("button", { name: "Empty Trash permanently" })
    .click();
  await expect(trash).toContainText("Trash is empty.");
});

test("stale count/storage is refused and Electron startup completes a pending purge after a failed catalog commit", async ({
  application,
  seeded,
  profile,
}) => {
  const library = await application.firstWindow();
  await value(library, "deleteBook", seeded.Atlas);
  const snapshot = await value<TrashListing>(library, "trash");
  await value(library, "deleteBook", seeded.Scan);
  expect(
    (
      await call(
        library,
        "emptyTrash",
        snapshot.entries.map((e) => e.id),
        snapshot.bytes,
      )
    ).ok,
  ).toBe(false);
  expect(await readdir(join(profile, "library/files"))).toHaveLength(2);
  const db = new DatabaseSync(join(profile, "library/catalog.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER refuse_purge BEFORE DELETE ON trash_entries BEGIN SELECT RAISE(ABORT, 'catalog full'); END",
    );
    const current = await value<TrashListing>(library, "trash");
    const result = await value<{ purged: number; failures: unknown[] }>(
      library,
      "emptyTrash",
      current.entries.map((e) => e.id),
      current.bytes,
    );
    expect(result.purged).toBe(0);
    expect(result.failures).toHaveLength(2);
    expect(await readdir(join(profile, "library/files"))).toEqual([]);
    db.exec("DROP TRIGGER refuse_purge");
  } finally {
    db.close();
  }
  await application.close();
  const restarted = await launch(profile);
  try {
    const next = await restarted.firstWindow();
    await showTrash(next);
    await expect(
      next.getByText("Trash is empty.", { exact: true }),
    ).toBeVisible();
    expect(
      catalog(profile, (db) => db.prepare("SELECT * FROM books").all()),
    ).toEqual([]);
    expect(
      catalog(profile, (db) =>
        db
          .prepare(
            "SELECT * FROM recovery_operations WHERE kind = 'purge' AND state <> 'committed'",
          )
          .all(),
      ),
    ).toEqual([]);
  } finally {
    await restarted.close();
  }
});
