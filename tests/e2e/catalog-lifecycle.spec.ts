import { acknowledged, openCatalogReader, stored } from "./catalog";
import { expect, launch, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
    ],
  },
});

test("A5: catalog readers reuse and activate, outlive the library and save on last-window exit", async ({
  application,
  profile,
  seeded,
}) => {
  const nativeProcess = application.process();
  const pdf = await openCatalogReader(application, "Known PDF");
  const native = await application.browserWindow(pdf.reader);
  const identity = await native.evaluate((window) => {
    const focus = window.focus.bind(window);
    Reflect.set(window, "activationRequests", 0);
    window.focus = () => {
      Reflect.set(
        window,
        "activationRequests",
        Number(Reflect.get(window, "activationRequests")) + 1,
      );
      focus();
    };
    return { id: window.id, contents: window.webContents.id };
  });
  const epub = await openCatalogReader(application, "Reflowable EPUB");
  await acknowledged(pdf.reader);
  const generation = stored(profile, seeded["Known PDF"] as string).generation;
  const results = await pdf.library.evaluate(
    async (id) =>
      Promise.all([
        window.borges.library.openBook(id),
        window.borges.library.openBook(id),
      ]),
    seeded["Known PDF"] as string,
  );
  expect(results).toEqual([
    { ok: true, value: null },
    { ok: true, value: null },
  ]);
  expect(application.windows()).toHaveLength(3);
  expect(
    await native.evaluate((window) => ({
      id: window.id,
      contents: window.webContents.id,
      visible: window.isVisible(),
      activationRequests: Reflect.get(window, "activationRequests"),
    })),
  ).toEqual({ ...identity, visible: true, activationRequests: 2 });
  expect(stored(profile, seeded["Known PDF"] as string).generation).toBe(
    generation,
  );

  await pdf.ui.getByRole("button", { name: "Next", exact: true }).click();
  const zoom = pdf.ui.getByRole("spinbutton", { name: "Zoom" });
  await zoom.fill("1.5");
  await zoom.press("Tab");
  await epub.ui.getByRole("button", { name: "Search", exact: true }).click();
  const query = epub.ui.getByRole("searchbox");
  await query.fill("LANTERN PASSAGE 24.");
  await expect(epub.ui.locator("#search-status")).toHaveText("1 matches");
  await query.press("Enter");
  await query.press("Escape");
  const font = epub.ui.getByRole("spinbutton", { name: "Font size" });
  await font.fill("28");
  await font.press("Tab");
  await expect(epub.ui.getByTestId("visible-text")).toContainText(
    "LANTERN PASSAGE 24.",
  );

  await pdf.library.close();
  expect(application.windows()).toHaveLength(2);
  const opened = application.waitForEvent("window");
  await epub.reader
    .getByRole("button", { name: "Open library", exact: true })
    .click();
  const library = await opened;
  await expect(
    library.getByRole("navigation", { name: "Library" }),
  ).toBeVisible();
  await pdf.reader
    .getByRole("button", { name: "Open library", exact: true })
    .click();
  expect(application.windows()).toHaveLength(3);
  // Closing/reopening the library never grants a new reader session.
  expect(stored(profile, seeded["Known PDF"] as string).generation).toBe(
    generation,
  );
  await library.close();
  await (await application.browserWindow(epub.reader)).evaluate((window) =>
    window.close(),
  );
  await expect.poll(() => epub.reader.isClosed()).toBe(true);
  const exited = application.waitForEvent("close");
  await native.evaluate((window) => window.close());
  await exited;
  await expect.poll(() => nativeProcess.exitCode).toBe(0);

  const restarted = await launch(profile);
  try {
    const libraryAgain = await restarted.firstWindow();
    await expect(
      libraryAgain.getByRole("navigation", { name: "Library" }),
    ).toBeVisible();
    expect(restarted.windows()).toHaveLength(1);
    const pdfAgain = await openCatalogReader(restarted, "Known PDF");
    await expect(pdfAgain.ui.getByTestId("page-text")).toContainText(
      "CEDAR SECOND",
    );
    await expect(
      pdfAgain.ui.getByRole("spinbutton", { name: "Zoom" }),
    ).toHaveValue("1.5");
    const epubAgain = await openCatalogReader(restarted, "Reflowable EPUB");
    await expect(epubAgain.ui.getByTestId("visible-text")).toContainText(
      "LANTERN PASSAGE 24.",
    );
    await expect(
      epubAgain.ui.getByRole("spinbutton", { name: "Font size" }),
    ).toHaveValue("28");
  } finally {
    await restarted.close();
  }
});
