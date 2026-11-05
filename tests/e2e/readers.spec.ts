import { expect, test } from "./desktop";

for (const sample of [
  { title: "Sample PDF", marker: "ORCHID FIRST", pdf: true },
  { title: "Image-only PDF", marker: "No text on this page", pdf: true },
  { title: "Sample EPUB", marker: "ORCHID EPUB FIRST", pdf: false },
  { title: "Fixed EPUB", marker: "ORCHID EPUB FIRST", pdf: false },
  { title: "Obfuscated-font EPUB", marker: "ORCHID EPUB FIRST", pdf: false },
]) {
  test(`offline format adapter renders ${sample.title}`, async ({
    application,
  }) => {
    const library = await application.firstWindow();
    const opened = application.waitForEvent("window");
    await library
      .getByRole("button", { name: `Open ${sample.title}`, exact: true })
      .click();
    const reader = await opened;
    const surface = reader.frameLocator('iframe[title="Book content"]');
    await expect(surface.getByRole("status")).toContainText("Ready");
    const frame = reader
      .frames()
      .find((candidate) => candidate.url().includes("borges://reader-"));
    expect(frame).toBeDefined();
    expect(
      await frame?.evaluate(() => typeof Reflect.get(window, "development")),
    ).toBe("undefined");
    expect(
      await frame?.evaluate(() => {
        try {
          Reflect.get(parent, "development");
          return "accessible";
        } catch (error) {
          return error instanceof DOMException ? error.name : String(error);
        }
      }),
    ).toBe("SecurityError");
    if (sample.pdf) {
      await expect(surface.getByTestId("page-text")).toContainText(
        sample.marker,
      );
      // Assert a known coral pixel from the embedded image, not just a canvas element.
      const pixel = await surface
        .locator(".pdf-page > canvas")
        .evaluate((canvas: HTMLCanvasElement) => {
          const ctx = canvas.getContext("2d");
          const pixels = ctx?.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          if (!pixels) return false;
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              pixels[i] === 224 &&
              pixels[i + 1] === 80 &&
              pixels[i + 2] === 48
            )
              return true;
          }
          return false;
        });
      expect(pixel).toBe(true);
    } else {
      await expect
        .poll(
          () =>
            reader
              .frames()
              .filter((candidate) =>
                candidate.url().startsWith("blob:borges://reader-"),
              ).length,
        )
        .toBe(1);
      const chapter = reader
        .frames()
        .find((candidate) =>
          candidate.url().startsWith("blob:borges://reader-"),
        );
      if (!chapter) throw new Error("No chapter frame");
      await expect(chapter.locator("body")).toContainText(sample.marker);
      const image = chapter.getByAltText("Coral square");
      await expect(image).toBeVisible();
      expect(
        await image.evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth === 24,
        ),
      ).toBe(true);
      if (sample.title === "Obfuscated-font EPUB") {
        expect(
          await chapter.locator("body").evaluate(async () => {
            await document.fonts.ready;
            return [...document.fonts].some(
              (font) => font.family === "Fixture" && font.status === "loaded",
            );
          }),
        ).toBe(true);
      }
    }
    await expect(surface.getByRole("alert")).toHaveCount(0);
  });
}

test("a corrupt PDF reports failure while another reader remains usable", async ({
  application,
}) => {
  await application
    .context()
    .route("**/reader-assets/fixtures/known.pdf", (route) =>
      route.fulfill({ body: "not a PDF", contentType: "application/pdf" }),
    );
  const library = await application.firstWindow();
  const failedOpened = application.waitForEvent("window");
  await library
    .getByRole("button", { name: "Open Sample PDF", exact: true })
    .click();
  const failed = await failedOpened;
  await expect(
    failed.frameLocator('iframe[title="Book content"]').getByRole("alert"),
  ).toContainText("Invalid PDF");
  const goodOpened = application.waitForEvent("window");
  await library
    .getByRole("button", { name: "Open Sample EPUB", exact: true })
    .click();
  const good = await goodOpened;
  await expect(
    good.frameLocator('iframe[title="Book content"]').getByRole("status"),
  ).toHaveText("Ready");
});
