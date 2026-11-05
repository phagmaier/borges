import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Frame, Locator, Page } from "@playwright/test";
import {
  representativeEpub,
  representativePdf,
} from "../measure/representative";
import { catalog, openCatalogReader } from "./catalog";
import { expect, launch, seedCatalog, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "reader-corpus.pdf", name: "Corpus PDF.pdf" },
      { fixture: "reader-corpus.epub", name: "Corpus EPUB.epub" },
      { fixture: "reader-legacy.epub", name: "Legacy EPUB.epub" },
      { fixture: "fixed.epub", name: "Fixed EPUB.epub" },
    ],
  },
});

test.describe("corpus import", () => {
  test.use({ catalog: { books: [] } });
  test("the varied corpus passes the real bounded import inspector with sources preserved", async ({
    application,
    profile,
  }) => {
    const library = await application.firstWindow();
    await expect(library.getByTestId("library-id")).toHaveText(
      /^[0-9a-f-]{36}$/,
    );
    const names = [
      "reader-corpus.pdf",
      "reader-corpus.epub",
      "reader-legacy.epub",
      "fixed.epub",
    ];
    const files = names.map((name) => resolve("tests/fixtures", name));
    const hashes = () =>
      Promise.all(
        files.map(async (file) =>
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ),
      );
    const before = await hashes();
    await application.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: files,
      })) as typeof dialog.showOpenDialog;
    }, files);
    await library.getByRole("button", { name: "Import files…" }).click();
    await expect(library.getByTestId("import-counts")).toHaveText(
      "4 imported",
      { timeout: 20_000 },
    );
    expect(
      catalog(profile, (db) =>
        db
          .prepare(
            "SELECT original_filename FROM revisions ORDER BY original_filename",
          )
          .all()
          .map((row) => row.original_filename),
      ),
    ).toEqual([...names].sort());
    expect(await hashes()).toEqual(before);
  });
});

for (const format of ["PDF", "EPUB"]) {
  test(`${format} external references offer explicit Copy Link without navigation`, async ({
    application,
  }) => {
    const library = await application.firstWindow();
    await expect(library.getByTestId("library-id")).toHaveText(
      /^[0-9a-f-]{36}$/,
    );
    const original = await application.evaluate(({ clipboard }) =>
      clipboard.readText(),
    );
    const requests: string[] = [];
    application.context().on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    try {
      await application.evaluate(({ clipboard }) =>
        clipboard.writeText("clipboard control"),
      );
      const { reader, ui } = await openCatalogReader(
        application,
        `Corpus ${format}`,
      );
      const engineUrl = reader
        .frames()
        .find((f) => f.url().startsWith("borges://reader-"))
        ?.url();
      const surfaceSize = await ui.locator("#surface").boundingBox();
      const chapter = reader
        .frames()
        .find((f) => f.url().startsWith("blob:borges://reader-"));
      const reference =
        format === "PDF"
          ? ui.getByRole("button", {
              name: "External link: https://example.invalid/garden?q=cedar#leaf",
              exact: true,
            })
          : chapter?.getByRole("link", { name: "External garden reference" });
      if (!reference) throw new Error("Missing reference");
      await expect(reference).toBeVisible();
      await reference.click();
      const dialog = reader.getByRole("dialog", { name: "External reference" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("textbox", { name: "Link address" }),
      ).toHaveValue("https://example.invalid/garden?q=cedar#leaf");
      expect(
        await application.evaluate(({ clipboard }) => clipboard.readText()),
      ).toBe("clipboard control");
      await dialog
        .getByRole("button", { name: "Copy Link", exact: true })
        .click();
      await expect(dialog.getByRole("status")).toHaveText("Link copied");
      expect(
        await application.evaluate(({ clipboard }) => clipboard.readText()),
      ).toBe("https://example.invalid/garden?q=cedar#leaf");
      await reader.screenshot({
        path: `test-results/corpus-${format.toLowerCase()}-copy-link.png`,
      });
      await dialog.press("Escape");
      await expect(dialog).toBeHidden();
      expect(await ui.locator("#surface").boundingBox()).toEqual(surfaceSize);

      const mail =
        format === "PDF"
          ? ui.getByRole("button", {
              name: "External link: mailto:gardener@example.invalid",
              exact: true,
            })
          : chapter?.getByRole("link", { name: "Mail the gardener" });
      if (!mail) throw new Error("Missing mail link");
      await mail.focus();
      await mail.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox")).toHaveValue(
        "mailto:gardener@example.invalid",
      );
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      if (format === "EPUB" && chapter) {
        await chapter
          .getByRole("link", { name: "Protocol relative reference" })
          .click();
        await expect(dialog.getByRole("textbox")).toHaveValue(
          "https://example.invalid/protocol-relative",
        );
        await dialog.press("Escape");
      }
      expect(
        reader
          .frames()
          .find((f) => f.url().startsWith("borges://reader-"))
          ?.url(),
      ).toBe(engineUrl);
      expect(reader.url()).toBe("borges://app/index.html");
      expect(application.windows()).toHaveLength(2);
      expect(requests).toEqual([]);
      await reader.screenshot({
        path: `test-results/corpus-${format.toLowerCase()}.png`,
      });
    } finally {
      await application
        .evaluate(({ clipboard }, text) => clipboard.writeText(text), original)
        .catch(() => {}); // App teardown after a failed launch/timeout.
    }
  });
}

function chapter(reader: Page): Frame {
  const frame = reader
    .frames()
    .find((f) => f.url().startsWith("blob:borges://reader-"));
  if (!frame) throw new Error("Missing chapter frame");
  return frame;
}

test("only an assigned engine can propose a reference and only a reader can copy a validated address", async ({
  application,
}) => {
  const { reader, library } = await openCatalogReader(
    application,
    "Corpus EPUB",
  );
  const original = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  try {
    await application.evaluate(({ clipboard }) =>
      clipboard.writeText("copy boundary control"),
    );
    const refused = await library.evaluate(() =>
      window.borges.reader
        .copyLink("https://example.invalid/")
        .then(() => "allowed", String),
    );
    expect(refused).toContain("Only a reader window");
    const invalid = await reader.evaluate(async () =>
      Promise.all(
        [
          "javascript:alert(1)",
          "file:///etc/passwd",
          "borges://app/index.html",
          "https://",
          "https://example.invalid/\nforged",
        ].map((url) =>
          window.borges.reader.copyLink(url).then(() => "allowed", String),
        ),
      ),
    );
    expect(
      invalid.every((message) =>
        message.includes("Invalid external reference"),
      ),
    ).toBe(true);
    await reader.evaluate(() => {
      window.addEventListener("message", (event) => {
        if (event.data?.type === "probe:done")
          document.documentElement.dataset.linkProbe = "done";
      });
    });
    await chapter(reader).evaluate(() => {
      top?.postMessage(
        {
          type: "borges:external-link",
          href: "https://example.invalid/forged",
        },
        "*",
      );
      parent.postMessage(
        {
          type: "borges:external-link",
          href: "https://example.invalid/forged",
        },
        "*",
      );
      top?.postMessage({ type: "probe:done" }, "*");
    });
    await expect(reader.locator("html")).toHaveAttribute(
      "data-link-probe",
      "done",
    );
    await expect(reader.getByRole("dialog")).toBeHidden();
    expect(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
    ).toBe("copy boundary control");
  } finally {
    await application
      .evaluate(({ clipboard }, text) => clipboard.writeText(text), original)
      .catch(() => {});
  }
});

/** Native Ctrl+C after selecting real reader text; no clipboard API in books. */
async function selectText(reader: Page, target: Locator) {
  await target.click();
  const box = await target.boundingBox();
  const text = await target.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()];
    const first = rects[0];
    const last = rects.at(-1);
    const rect = element.getBoundingClientRect();
    return first && last
      ? {
          x1: first.left - rect.left + 1,
          y1: first.top - rect.top + first.height / 2,
          x2: last.right - rect.left - 1,
          y2: last.top - rect.top + last.height / 2,
        }
      : null;
  });
  if (!box || !text) throw new Error("Missing selectable text");
  await reader.mouse.move(box.x + text.x1, box.y + text.y1);
  await reader.mouse.down();
  await reader.mouse.move(box.x + text.x2, box.y + text.y2, { steps: 8 });
  await reader.mouse.up();
  const selected = await target.evaluate((element) =>
    element.ownerDocument.getSelection()?.toString(),
  );
  await reader.keyboard.press("Control+c");
  return selected;
}

test("PDF named links, outlines, selection and images survive varied page geometry and resizing", async ({
  application,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Corpus PDF");
  const original = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  try {
    expect(
      await selectText(
        reader,
        ui.locator(".textLayer span").filter({ hasText: "lantern lantern" }),
      ),
    ).toBe("lantern lantern");
    expect(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
    ).toBe("lantern lantern");
    await ui.getByRole("button", { name: "Go to page 2", exact: true }).click();
    await expect(ui.getByTestId("page-text")).toContainText("LANDSCAPE CEDAR");
    for (const [page, marker, landscape] of [
      [2, "LANDSCAPE CEDAR", true],
      [3, "ROTATED HARBOR", true],
      [4, "CROPPED ORCHID", false],
    ] as const) {
      const jump = ui.getByRole("textbox", { name: "Jump" });
      await jump.fill(String(page));
      await jump.press("Enter");
      await expect(ui.getByTestId("page-text")).toContainText(marker);
      const canvas = ui.locator(".pdf-page > canvas");
      const dimensions = await canvas.evaluate((el: HTMLCanvasElement) => [
        el.width,
        el.height,
      ]);
      expect((dimensions[0] ?? 0) > (dimensions[1] ?? 0)).toBe(landscape);
      await expect
        .poll(() =>
          canvas.evaluate((el: HTMLCanvasElement) => {
            const pixels = el
              .getContext("2d")
              ?.getImageData(0, 0, el.width, el.height).data;
            return pixels?.some(
              (value, index) =>
                index % 4 === 0 &&
                value === 224 &&
                pixels[index + 1] === 80 &&
                pixels[index + 2] === 48,
            );
          }),
        )
        .toBe(true);
    }
    await ui
      .getByRole("combobox", { name: "Contents" })
      .selectOption({ label: "Harbor" });
    await expect(ui.getByTestId("page-text")).toContainText("ROTATED HARBOR");
    await reader
      .locator('iframe[title="Book content"]')
      .evaluate((el: HTMLIFrameElement) => {
        el.style.width = "600px";
        el.style.flex = "none";
        el.style.height = "420px";
      });
    const zoom = ui.getByRole("spinbutton", { name: "Zoom" });
    await zoom.fill("3");
    await zoom.press("Tab");
    await expect
      .poll(() =>
        ui
          .locator("#surface")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
      )
      .toBe(true);
    await ui.getByRole("button", { name: "Fit page", exact: true }).click();
    await expect
      .poll(() =>
        ui
          .locator("#surface")
          .evaluate(
            (el) =>
              el.scrollWidth <= el.clientWidth + 1 &&
              el.scrollHeight <= el.clientHeight + 1,
          ),
      )
      .toBe(true);
    await expect(ui.getByTestId("page-text")).toContainText("ROTATED HARBOR");
    await reader
      .locator('iframe[title="Book content"]')
      .screenshot({ path: "test-results/corpus-rotated-pdf.png" });
  } finally {
    await application
      .evaluate(({ clipboard }, text) => clipboard.writeText(text), original)
      .catch(() => {});
  }
});

test("EPUB nested paths, footnotes, selection, illustrations and large text preserve the linked passage", async ({
  application,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Corpus EPUB");
  const original = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  try {
    expect(await selectText(reader, chapter(reader).locator("#opening"))).toBe(
      "GARDEN COPY: café, naïve, Ω.",
    );
    expect(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
    ).toBe("GARDEN COPY: café, naïve, Ω.");
    await chapter(reader)
      .getByRole("link", { name: "Garden footnote", exact: true })
      .click();
    await expect(ui.getByTestId("visible-text")).toContainText(
      "GARDEN FOOTNOTE DESTINATION.",
    );
    await chapter(reader)
      .getByRole("link", { name: "Return to opening" })
      .click();
    await expect(ui.getByTestId("visible-text")).toContainText("GARDEN COPY:");
    await chapter(reader)
      .getByRole("link", { name: "Across to Harbor" })
      .click();
    await expect(ui.getByTestId("visible-text")).toContainText(
      "HARBOR ANCHOR DESTINATION.",
    );
    await expect(chapter(reader).getByAltText("Vector garden")).toBeVisible();
    expect(
      await chapter(reader)
        .getByAltText("Vector garden")
        .evaluate(
          (img: HTMLImageElement) =>
            img.complete &&
            img.naturalWidth === 180 &&
            img.naturalHeight === 120,
        ),
    ).toBe(true);
    expect(
      await chapter(reader)
        .locator("body")
        .evaluate(async () => {
          await document.fonts.ready;
          return [...document.fonts].some(
            (font) => font.family === "Fixture" && font.status === "loaded",
          );
        }),
    ).toBe(true);
    // A Contents/search restore leaves an explicit anchor. A later clicked
    // link must replace that anchor before font changes and resize restore it.
    await ui
      .getByRole("combobox", { name: "Contents" })
      .selectOption({ label: "Harbor" });
    await chapter(reader)
      .getByRole("link", { name: "Return to Garden" })
      .click();
    await expect(ui.getByTestId("visible-text")).toContainText("GARDEN COPY:");
    await ui.getByRole("spinbutton", { name: "Font size" }).fill("40");
    await ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
    await expect(ui.getByTestId("visible-text")).toContainText("GARDEN COPY:");
    await reader
      .locator('iframe[title="Book content"]')
      .evaluate((el: HTMLIFrameElement) => {
        el.style.width = "600px";
        el.style.flex = "none";
        el.style.height = "420px";
      });
    await expect(ui.getByTestId("visible-text")).toContainText("GARDEN COPY:");
    await ui.getByRole("button", { name: "Search", exact: true }).click();
    await ui.getByRole("searchbox").fill("LANTERN PASSAGE 40.");
    await expect(ui.getByRole("list").getByRole("button")).toHaveCount(1);
    await ui.getByRole("searchbox").press("Enter");
    await expect(ui.getByTestId("visible-text")).toContainText(
      "LANTERN PASSAGE 40.",
    );
    await reader
      .locator('iframe[title="Book content"]')
      .screenshot({ path: "test-results/corpus-large-epub.png" });
  } finally {
    await application
      .evaluate(({ clipboard }, text) => clipboard.writeText(text), original)
      .catch(() => {});
  }
});

test("EPUB 2 NCX and RTL content navigate in catalog readers", async ({
  application,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Legacy EPUB");
  await expect(ui.getByTestId("visible-text")).toContainText("مرحبا بالحديقة");
  await expect(chapter(reader).getByAltText("Coral square")).toBeVisible();
  await expect(
    ui.getByRole("combobox", { name: "Contents" }).locator("option"),
  ).toHaveText(["Choose…", "Legacy Orchid", "— Legacy Harbor"]);
  await ui
    .getByRole("combobox", { name: "Contents" })
    .selectOption({ label: "— Legacy Harbor" });
  await expect(ui.getByTestId("visible-text")).toContainText(
    "HARBOR EPUB SECOND",
  );
  await ui.getByRole("region", { name: "Reading surface" }).press("ArrowLeft");
  await expect(ui.getByTestId("visible-text")).toContainText(
    "ORCHID EPUB FIRST",
  );
  await reader
    .locator('iframe[title="Book content"]')
    .screenshot({ path: "test-results/corpus-legacy-epub.png" });
});

test("fixed-layout catalog EPUB fits one page and pans without changing chapter", async ({
  application,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Fixed EPUB");
  await expect(ui.getByRole("spinbutton", { name: "Font size" })).toBeHidden();
  await reader
    .locator('iframe[title="Book content"]')
    .evaluate((el: HTMLIFrameElement) => {
      el.style.width = "600px";
      el.style.flex = "none";
      el.style.height = "420px";
    });
  const renderer = ui.locator("foliate-view");
  await ui.getByRole("spinbutton", { name: "Zoom" }).fill("3");
  await ui.getByRole("spinbutton", { name: "Zoom" }).press("Tab");
  await chapter(reader).locator("body").hover();
  await reader.mouse.wheel(160, 240);
  await expect
    .poll(() =>
      renderer.evaluate((el) => Reflect.get(el, "renderer").scrollTop),
    )
    .toBeGreaterThan(0);
  await expect(ui.getByTestId("visible-text")).toContainText(
    "ORCHID EPUB FIRST",
  );
  await ui.getByRole("button", { name: "Fit page", exact: true }).click();
  await expect
    .poll(() =>
      renderer.evaluate((el) => {
        const page = Reflect.get(el, "renderer") as HTMLElement;
        return (
          page.scrollWidth <= page.clientWidth + 1 &&
          page.scrollHeight <= page.clientHeight + 1
        );
      }),
    )
    .toBe(true);
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect(ui.getByTestId("visible-text")).toContainText(
    "HARBOR EPUB SECOND",
  );
  expect(
    reader.frames().filter((f) => f.url().startsWith("blob:borges://reader-"))
      .length,
  ).toBe(1);
  await expect(chapter(reader).getByAltText("Coral square")).toBeVisible();
  await reader
    .locator('iframe[title="Book content"]')
    .screenshot({ path: "test-results/corpus-fixed-epub.png" });
});

test("book-length PDF and EPUB search reach known late passages in catalog readers", async ({
  profile,
}) => {
  test.setTimeout(60_000);
  const files = await mkdtemp(join(tmpdir(), "borges-reader-corpus-"));
  const pdf = representativePdf();
  const epub = representativeEpub();
  try {
    await writeFile(join(files, "long.pdf"), pdf.bytes);
    await writeFile(join(files, "long.epub"), epub.bytes);
    await seedCatalog(profile, [
      { fixture: join(files, "long.pdf"), name: "Long PDF.pdf" },
      { fixture: join(files, "long.epub"), name: "Long EPUB.epub" },
    ]);
    const application = await launch(profile);
    try {
      for (const format of ["PDF", "EPUB"]) {
        const { reader, ui } = await openCatalogReader(
          application,
          `Long ${format}`,
        );
        await ui.getByRole("button", { name: "Search", exact: true }).click();
        await ui.getByRole("searchbox").fill("quartzfinal");
        await expect(ui.locator("#search-status")).toHaveText("1 matches");
        await ui.getByRole("searchbox").press("Enter");
        await expect(ui.getByTestId("visible-text")).toContainText(
          "quartzfinal",
        );
        await expect(ui.locator("#location")).toContainText(
          format === "PDF"
            ? `Page ${pdf.rareLocation} of 400`
            : `Chapter ${epub.rareLocation}`,
        );
        await ui.getByRole("searchbox").press("Escape");
        const sizing = ui.getByRole("spinbutton", {
          name: format === "PDF" ? "Zoom" : "Font size",
        });
        await sizing.fill(format === "PDF" ? "2" : "32");
        await sizing.press("Tab");
        await expect(ui.getByTestId("visible-text")).toContainText(
          "quartzfinal",
        );
        await reader.close();
      }
    } finally {
      await application.close();
    }
  } finally {
    await rm(files, { recursive: true, force: true });
  }
});
