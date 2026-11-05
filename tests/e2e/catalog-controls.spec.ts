import { openCatalogReader } from "./catalog";
import { expect, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "image-only.pdf", name: "Image PDF.pdf" },
      { fixture: "reader-controls.epub", name: "Reader EPUB.epub" },
    ],
  },
});

test("catalog PDF search reopens with usable results and retains its match through sizing", async ({
  application,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Known PDF");
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.press("ArrowRight");
  await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
  await surface.press("ArrowDown");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await surface.press("ArrowRight");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await surface.press(":");
  const jump = ui.getByRole("textbox", { name: "Jump" });
  await expect(jump).toBeFocused();
  await jump.fill("4");
  await jump.press("Enter");
  await expect(ui.getByRole("alert")).toContainText("1–3");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await jump.fill("1");
  await ui.getByRole("button", { name: "Go", exact: true }).click();
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  await ui.getByRole("button", { name: "Previous", exact: true }).focus();
  await ui.getByRole("button", { name: "Previous", exact: true }).press("Tab");
  const next = ui.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeFocused();
  await next.press("ArrowRight");
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  await next.press("Enter");
  await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
  await ui
    .getByRole("combobox", { name: "Contents" })
    .selectOption({ label: "Harbor" });
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await surface.press("/");
  const query = ui.getByRole("searchbox");
  await query.fill("lantern");
  await expect(ui.locator("#search-status")).toHaveText("6 matches");
  await query.press("Enter");
  await query.press("Enter");
  const highlightedOffset = () =>
    ui.locator(".textLayer").evaluate(() => {
      const range = [...(CSS.highlights.get("reader-search") ?? [])][0];
      return range?.startContainer.isConnected && range.toString() === "lantern"
        ? range.startOffset
        : -1;
    });
  await expect.poll(highlightedOffset).toBe(8);
  const zoom = ui.getByRole("spinbutton", { name: "Zoom" });
  await zoom.fill("3");
  await zoom.press("Tab");
  await expect
    .poll(() => surface.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  await expect.poll(highlightedOffset).toBe(8);
  await surface.hover({
    position: {
      x: 10,
      y: (await surface.evaluate((el) => el.clientHeight)) - 10,
    },
  });
  await reader.mouse.wheel(120, 150);
  await expect
    .poll(() => surface.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  const canvasWidth = await ui
    .locator(".pdf-page > canvas")
    .getAttribute("width");
  await reader
    .locator('iframe[title="Book content"]')
    .evaluate((frame: HTMLIFrameElement) => {
      frame.style.flex = "none";
      frame.style.width = "600px";
      frame.style.height = "420px";
    });
  await expect(ui.locator(".pdf-page > canvas")).not.toHaveAttribute(
    "width",
    canvasWidth ?? "",
  );
  await expect.poll(highlightedOffset).toBe(8);
  await ui.getByRole("button", { name: "Fit page", exact: true }).click();
  await expect(zoom).toHaveValue("1");
  await expect.poll(highlightedOffset).toBe(8);
  await query.press("Escape");
  await expect(surface).toBeFocused();
  await expect.poll(highlightedOffset).toBe(-1);
  await surface.press("/");
  await expect(query).toHaveValue("lantern");
  await expect(ui.getByRole("list").getByRole("button")).toHaveCount(6);
  await query.press("Shift+Enter");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await query.fill("ORCHID");
  await query.fill("CEDAR");
  await expect(ui.getByRole("list").getByRole("button")).toHaveCount(1);
  await query.press("Enter");
  await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
  await query.fill("absent phrase");
  await expect(ui.locator("#search-status")).toHaveText("No matches");
  await query.press("Escape");
  await surface.press("ArrowLeft");
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  await surface.press("ArrowLeft");
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  await surface.hover();
  await reader.mouse.wheel(120, 150);
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  // Reusing the last outline entry after another navigation must work.
  const contents = ui.getByRole("combobox", { name: "Contents" });
  await contents.focus();
  await contents.press("End");
  await contents.press("Enter");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");

  const image = await openCatalogReader(application, "Image PDF");
  await image.ui.getByRole("button", { name: "Search", exact: true }).click();
  await image.ui.getByRole("searchbox").fill("ORCHID");
  await expect(image.ui.locator("#search-status")).toHaveText(
    "Text unavailable in this book",
  );
});

test("catalog EPUB search can be closed and reopened without losing its query results", async ({
  application,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Reader EPUB");
  await ui
    .getByRole("combobox", { name: "Contents" })
    .selectOption({ label: "Harbor" });
  await expect(ui.getByTestId("visible-text")).toContainText(
    "HARBOR EPUB SECOND",
  );
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.press(":");
  const jump = ui.getByRole("textbox", { name: "Jump" });
  await jump.fill("101%");
  await jump.press("Enter");
  await expect(ui.getByRole("alert")).toContainText("0–100%");
  await expect(ui.getByTestId("visible-text")).toContainText(
    "HARBOR EPUB SECOND",
  );
  await jump.fill("0%");
  await jump.press("Enter");
  await expect(ui.getByTestId("visible-text")).toContainText(
    "ORCHID EPUB FIRST",
  );
  await ui.getByRole("button", { name: "Search", exact: true }).click();
  const query = ui.getByRole("searchbox");
  await query.fill("LANTERN PASSAGE 24.");
  await expect(ui.getByRole("list").getByRole("button")).toHaveCount(1);
  await query.press("Enter");
  await expect(ui.getByTestId("visible-text")).toContainText(
    "LANTERN PASSAGE 24.",
  );
  await query.press("Escape");
  await ui.getByRole("region", { name: "Reading surface" }).press("/");
  await expect(query).toHaveValue("LANTERN PASSAGE 24.");
  await expect(ui.getByRole("list").getByRole("button")).toHaveCount(1);
  await query.press("Shift+Enter");
  await ui.getByRole("spinbutton", { name: "Font size" }).fill("24");
  await ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
  await reader
    .locator('iframe[title="Book content"]')
    .evaluate((frame: HTMLIFrameElement) => {
      frame.style.flex = "none";
      frame.style.width = "600px";
      frame.style.height = "420px";
    });
  await expect.poll(() => surface.evaluate((el) => el.clientWidth)).toBe(600);
  await expect(ui.getByTestId("visible-text")).toContainText(
    "LANTERN PASSAGE 24.",
  );
  await ui.getByRole("button", { name: "Close search" }).click();
  await expect(
    ui.getByRole("region", { name: "Reading surface" }),
  ).toBeFocused();
  // At a narrow width, every visible control remains in the content viewport.
  expect(
    await ui.locator("nav").evaluate((nav) =>
      [...nav.querySelectorAll<HTMLElement>("button,input,select")]
        .filter((el) => el.checkVisibility())
        .every((el) => {
          const rect = el.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          );
        }),
    ),
  ).toBe(true);
  await reader
    .locator('iframe[title="Book content"]')
    .screenshot({ path: "test-results/catalog-reader-controls.png" });
});

test("publisher lists and dialogs keep their keys while the EPUB surface turns pages", async ({
  application,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Reader EPUB");
  const chapter = reader
    .frames()
    .find((frame) => frame.url().startsWith("blob:borges://reader/"));
  if (!chapter) throw new Error("Missing EPUB chapter");
  await chapter.evaluate(() => {
    document.addEventListener("keydown", (event) => {
      document.body.dataset.keyPrevented = String(event.defaultPrevented);
    });
  });
  for (const name of ["Chapter index", "Publisher dialog"]) {
    const target = chapter.getByLabel(name);
    await target.focus();
    for (const key of ["ArrowRight", "/", ":"]) {
      await target.press(key);
      await expect(chapter.locator("body")).toHaveAttribute(
        "data-key-prevented",
        "false",
      );
      await expect(target).toBeFocused();
      await expect(ui.getByRole("searchbox")).toBeHidden();
    }
  }
  const surface = ui.getByRole("region", { name: "Reading surface" });
  const before = await ui.getByTestId("visible-text").textContent();
  await surface.press("ArrowRight");
  await expect(ui.getByTestId("visible-text")).not.toHaveText(before ?? "");
});
