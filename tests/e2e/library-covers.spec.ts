import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication } from "@playwright/test";
import { bookButton, call, catalog, openCatalogReader, value } from "./catalog";
import { expect, launch, test } from "./desktop";

async function imageFile(
  application: ElectronApplication,
  path: string,
  format: "png" | "jpeg" = "png",
) {
  const bytes = await application.evaluate(({ nativeImage }, format) => {
    // Solid coral, created locally; no third-party image provenance.
    const image = nativeImage.createFromBitmap(
      Buffer.from([80, 100, 240, 255]),
      { width: 1, height: 1 },
    );
    const large = image.resize({ width: 1000, height: 1500 });
    return Array.from(format === "png" ? large.toPNG() : large.toJPEG(90));
  }, format);
  await writeFile(path, Buffer.from(bytes));
}

async function chooser(application: ElectronApplication, path: string | null) {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: path === null,
      filePaths: path ? [path] : [],
    })) as typeof dialog.showOpenDialog;
  }, path);
}

test.describe("manual cover correction", () => {
  test.use({
    catalog: {
      books: [
        { fixture: "known.pdf", name: "Atlas.pdf" },
        { fixture: "reflowable.epub", name: "Other.epub" },
      ],
    },
  });

  test("chooses by content, decodes and bounds thumbnails, persists them, and keeps the old cover on failure or cancellation", async ({
    application,
    profile,
    seeded,
  }) => {
    const library = await application.firstWindow();
    const id = seeded.Atlas as string;
    const source = join(profile, "source.bin");
    await imageFile(application, source);
    const before = await readFile(source);
    await chooser(application, source);
    await library
      .getByRole("checkbox", { name: "Select Atlas", exact: true })
      .check();
    await library
      .getByRole("button", { name: "Choose cover…", exact: true })
      .click();
    await expect(library.getByRole("status")).toHaveText(
      "Saved cover for Atlas.",
    );
    const image = bookButton(library, "Atlas").locator("img");
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(512);
    expect(
      await image.evaluate((img: HTMLImageElement) => img.naturalHeight),
    ).toBe(768);
    const row = () =>
      catalog(profile, (db) => ({
        ...db
          .prepare("SELECT cover_path, cover_manual FROM books WHERE id = ?")
          .get(id),
      }));
    const first = row();
    expect(first.cover_manual).toBe(1);
    expect(await readFile(source)).toEqual(before);
    const firstBytes = await readFile(
      join(profile, "library", String(first.cover_path)),
    );
    await library.reload();
    await expect(bookButton(library, "Atlas").locator("img")).toBeVisible();
    await library
      .getByRole("checkbox", { name: "Select Atlas", exact: true })
      .check();
    await chooser(application, null);
    await value(library, "chooseCover", id);
    expect(row()).toEqual(first);
    // Correct header, invalid image payload: the real native decoder rejects it.
    await writeFile(source, before.subarray(0, 24));
    await chooser(application, source);
    await library
      .getByRole("button", { name: "Choose cover…", exact: true })
      .click();
    await expect(library.getByRole("alert")).toContainText(
      "readable PNG or JPEG",
    );
    expect(row()).toEqual(first);
    await imageFile(application, source, "jpeg");
    await library
      .getByRole("button", { name: "Choose cover…", exact: true })
      .click();
    await expect(library.getByRole("status")).toHaveText(
      "Saved cover for Atlas.",
    );
    expect(row().cover_path).not.toBe(first.cover_path);
    expect(
      await readFile(join(profile, "library", String(first.cover_path))),
    ).toEqual(firstBytes);
    // Reader shells cannot open the chooser or read even a known valid token.
    const { reader } = await openCatalogReader(application, "Atlas");
    const books = await value<{ id: string; coverToken: string | null }[]>(
      library,
      "books",
    );
    const token = books.find((book) => book.id === id)?.coverToken;
    expect(await call(reader, "chooseCover", id)).toMatchObject({
      thrown: expect.stringContaining("Only the library window"),
    });
    expect(await call(reader, "cover", id, token)).toMatchObject({
      thrown: expect.stringContaining("Only the library window"),
    });
    expect(await value(library, "cover", id, "../catalog.sqlite")).toBeNull();
    expect(await call(library, "chooseCover", null)).toMatchObject({
      ok: false,
      code: "invalid",
    });
    await application.close();
    const restarted = await launch(profile);
    try {
      const restored = await restarted.firstWindow();
      const persisted = bookButton(restored, "Atlas").locator("img");
      await expect
        .poll(() =>
          persisted.evaluate((img: HTMLImageElement) => img.naturalWidth),
        )
        .toBe(512);
      expect(row().cover_manual).toBe(1);
    } finally {
      await restarted.close();
    }
  });
});

test.describe("lazy cover display", () => {
  test.use({
    catalog: {
      // Distinct bytes per book: identical content would be skipped.
      books: Array.from({ length: 130 }, (_, i) => ({
        content: `%PDF-1.7\n% created placeholder ${i}\n`,
        name: `Atlas ${String(i).padStart(3, "0")}.pdf`,
      })),
    },
  });
  test("loads only nearby thumbnails and releases images as cards leave the viewport", async ({
    application,
    profile,
  }) => {
    const library = await application.firstWindow();
    await expect(library.locator(".result-count")).toHaveText("130 books");
    const path = join(profile, "library", "covers", "fixture.png");
    await imageFile(application, path);
    const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
    db.exec("UPDATE books SET cover_path = 'covers/fixture.png'");
    db.close();
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("library:changed");
    });
    const images = library.locator(".cover img");
    await expect.poll(() => images.count()).toBeGreaterThan(0);
    expect(await images.count()).toBeLessThan(40);
    const first = bookButton(library, "Atlas 000");
    await expect(first.locator("img")).toBeVisible();
    await library
      .getByRole("button", { name: "Show more books (30 more)" })
      .scrollIntoViewIfNeeded();
    await expect(bookButton(library, "Atlas 129")).toBeVisible();
    await expect.poll(() => first.locator("img").count()).toBe(0);
    expect(await images.count()).toBeLessThan(40);
    await first.scrollIntoViewIfNeeded();
    await expect(first.locator("img")).toBeVisible();
    await library.screenshot({ path: "test-results/library-covers.png" });
  });
});
