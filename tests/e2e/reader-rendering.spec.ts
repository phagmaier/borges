import { expect, test } from "./desktop";

// Exercise the ordinary catalog shell: diagnostic readers have a fixed-height
// frame and cannot expose the full-window layout/scrollbar feedback.
test.use({
  catalog: { books: [{ fixture: "known.pdf", name: "Known PDF.pdf" }] },
});

test("PDF publishes painted pages and settles without idle redraws", async ({
  application,
}) => {
  const library = await application.firstWindow();
  const opened = application.waitForEvent("window");
  await library
    .getByRole("list", { name: "Books" })
    .getByRole("button", { name: "Known PDF", exact: true })
    .press("Enter");
  const reader = await opened;
  const ui = reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByRole("status")).toHaveText("Ready");
  const surface = ui.locator("#surface");
  await surface.evaluate((element) => {
    const state = { publications: 0, unpainted: 0 };
    Reflect.set(window, "paintProbe", state);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== element) continue;
        state.publications++;
        const canvas = element.querySelector("canvas");
        // The created fixture has a coral square at PDF coordinates
        // [40,70]–[136,166] on every 320×320 page, independent of zoom.
        const pixel = canvas
          ?.getContext("2d")
          ?.getImageData(
            Math.floor(canvas.width * 0.25),
            Math.floor(canvas.height * 0.65),
            1,
            1,
          ).data;
        if (pixel?.[0] !== 224 || pixel[1] !== 80 || pixel[2] !== 48)
          state.unpainted++;
      }
    }).observe(element, { childList: true });
  });
  const publications = () =>
    surface.evaluate(() =>
      Number(Reflect.get(window, "paintProbe").publications),
    );
  const zoom = ui.getByRole("spinbutton", { name: "Zoom" });
  for (const value of ["2", "1"]) {
    const before = await publications();
    await zoom.fill(value);
    await zoom.press("Tab");
    await expect.poll(publications).toBe(before + 1);
    // Scrollbar notifications must not repaint the identical page again.
    await reader.waitForTimeout(250);
    expect(await publications()).toBe(before + 1);
  }
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  const atEnd = await publications();
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await reader.waitForTimeout(250);
  expect(await publications()).toBe(atEnd);
  // A real viewport change replaces the page once it is painted; leaving it
  // alone afterwards must not produce a resize/render cycle.
  await reader.setViewportSize({ width: 1001, height: 721 });
  await expect.poll(publications).toBeGreaterThan(atEnd);
  await reader.waitForTimeout(250);
  const settled = await publications();
  await reader.waitForTimeout(500);
  expect(await publications()).toBe(settled);
  expect(
    await surface.evaluate(() => Reflect.get(window, "paintProbe").unpainted),
  ).toBe(0);
  await expect(ui.getByRole("alert")).toHaveCount(0);
});

test.describe("fractional PDF page sizes", () => {
  test.use({
    catalog: { books: [{ fixture: "reader-corpus.pdf", name: "Corpus.pdf" }] },
  });
  test("fit-page sizing does not introduce scrollbars from bitmap rounding", async ({
    application,
  }) => {
    const library = await application.firstWindow();
    const opened = application.waitForEvent("window");
    await library
      .getByRole("list", { name: "Books" })
      .getByRole("button", { name: "Corpus", exact: true })
      .press("Enter");
    const reader = await opened;
    const ui = reader.frameLocator('iframe[title="Book content"]');
    await expect(ui.getByRole("status")).toHaveText("Ready");
    const jump = ui.getByRole("textbox", { name: "Jump" });
    for (const [page, marker] of [
      ["1", "PORTRAIT GARDEN"],
      ["2", "LANDSCAPE CEDAR"],
      ["3", "ROTATED HARBOR"],
      ["4", "CROPPED ORCHID"],
    ] as const) {
      await jump.fill(page);
      await jump.press("Enter");
      await expect(ui.getByTestId("page-text")).toContainText(marker);
      await expect
        .poll(() =>
          ui.locator("#surface").evaluate((element) => ({
            x: element.scrollWidth - element.clientWidth,
            y: element.scrollHeight - element.clientHeight,
          })),
        )
        .toEqual({ x: 0, y: 0 });
    }
  });
});
