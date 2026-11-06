import type { Page } from "@playwright/test";
import { catalog, openCatalogReader } from "./catalog";
import { expect, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reader-controls.epub", name: "Reader EPUB.epub" },
      { fixture: "fixed.epub", name: "Fixed EPUB.epub" },
    ],
  },
});

function chapter(reader: Page) {
  const frame = reader
    .frames()
    .find((f) => f.url().startsWith("blob:borges://reader-"));
  if (!frame) throw new Error("Missing EPUB chapter");
  return frame;
}

for (const title of ["Known PDF", "Reader EPUB", "Fixed EPUB"]) {
  test(`${title}: dark mode preserves reading, saves per book and restores original colours`, async ({
    application,
    profile,
    seeded,
  }) => {
    const { reader, ui } = await openCatalogReader(application, title);
    const marker = ui.getByTestId(
      title === "Known PDF" ? "page-text" : "visible-text",
    );
    if (title === "Reader EPUB")
      await ui
        .getByRole("combobox", { name: "Contents" })
        .selectOption({ label: "Harbor" });
    else await ui.getByRole("button", { name: "Next", exact: true }).click();
    await expect(marker).toContainText(
      title === "Known PDF" ? "CEDAR SECOND" : "HARBOR EPUB SECOND",
    );
    const before = await marker.textContent();
    const dark = ui.getByRole("button", { name: "Dark mode", exact: true });
    await expect(dark).toHaveAttribute("aria-pressed", "false");
    await dark.focus();
    await dark.press("Space");
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await expect(marker).toHaveText(before ?? "");
    await expect(reader.locator(".reader-window")).toHaveCSS(
      "color-scheme",
      "dark",
    );
    await expect(ui.locator("html")).toHaveCSS("color-scheme", "dark");
    if (title === "Reader EPUB") {
      await expect(chapter(reader).locator("body")).toHaveCSS(
        "color",
        "rgb(235, 227, 213)",
      );
      await expect(chapter(reader).locator("html")).toHaveCSS(
        "background-color",
        "rgb(29, 26, 22)",
      );
      await expect(ui.locator("foliate-view")).toHaveCSS("filter", "none");
      await expect(chapter(reader).getByAltText("Coral square")).toBeVisible();
    } else {
      await expect(
        ui.locator(title === "Known PDF" ? ".pdf-page" : "foliate-view"),
      ).toHaveCSS("filter", /invert/);
    }
    // Sizing and navigation must keep the selected appearance.
    await ui
      .getByRole("button", { name: "Dark mode", exact: true })
      .press("Control+=");
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await ui.getByRole("button", { name: "Search", exact: true }).click();
    await ui
      .getByRole("searchbox")
      .fill(title === "Known PDF" ? "CEDAR" : "HARBOR");
    await expect(ui.getByRole("list").getByRole("button")).not.toHaveCount(0);
    await ui.getByRole("searchbox").press("Escape");
    await expect(dark).toBeInViewport();
    await reader.screenshot({
      path: `test-results/dark-${title.replaceAll(" ", "-")}.png`,
    });
    await reader.evaluate(() => window.borges.reader.flush());
    const id = seeded[title] as string;
    expect(
      catalog(
        profile,
        (db) =>
          db
            .prepare("SELECT theme FROM reader_settings WHERE book_id = ?")
            .get(id)?.theme,
      ),
    ).toBe("dark");
    expect(
      catalog(
        profile,
        (db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM reader_settings WHERE book_id <> ? AND theme = 'dark'",
            )
            .get(id)?.n,
      ),
    ).toBe(0);
    await reader.close();
    const reopened = await openCatalogReader(application, title);
    const toggle = reopened.ui.getByRole("button", {
      name: "Dark mode",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(
      reopened.ui.getByTestId(
        title === "Known PDF" ? "page-text" : "visible-text",
      ),
    ).toContainText(
      title === "Known PDF" ? "CEDAR SECOND" : "HARBOR EPUB SECOND",
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    if (title === "Reader EPUB") {
      await expect(chapter(reopened.reader).locator("body")).not.toHaveCSS(
        "color",
        "rgb(235, 227, 213)",
      );
    } else {
      await expect(
        reopened.ui.locator(
          title === "Known PDF" ? ".pdf-page" : "foliate-view",
        ),
      ).toHaveCSS("filter", "none");
    }
    await reopened.reader.evaluate(() => window.borges.reader.flush());
    expect(
      catalog(
        profile,
        (db) =>
          db
            .prepare("SELECT theme FROM reader_settings WHERE book_id = ?")
            .get(id)?.theme,
      ),
    ).toBe("original");
  });
}
