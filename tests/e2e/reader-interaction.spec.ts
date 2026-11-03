import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { expect, test } from "./desktop";

async function openReader(application: ElectronApplication, title: string) {
  const library = await application.firstWindow();
  const opened = application.waitForEvent("window");
  await library
    .getByRole("button", { name: `Open ${title}`, exact: true })
    .click();
  const reader = await opened;
  const ui = reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByRole("status")).toContainText("Ready");
  return { reader, ui };
}
function chapter(reader: Page) {
  const frame = reader
    .frames()
    .find((frame) => frame.url().startsWith("blob:borges://reader/"));
  if (!frame) throw new Error("Missing visible EPUB chapter");
  return frame;
}

test("PDF arrows and validated jumps navigate physical pages without wrapping", async ({
  application,
}) => {
  const { ui } = await openReader(application, "Sample PDF");
  const surface = ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
  await surface.press("ArrowDown");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await surface.press("ArrowRight");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await surface.press(":");
  const jump = ui.getByRole("textbox", { name: "Jump" });
  await jump.fill("4");
  await jump.press("Enter");
  await expect(ui.getByRole("alert")).toContainText("1–3");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await jump.fill("1");
  await jump.press("ArrowRight"); // editing keys do not turn pages
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await jump.press("Enter");
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  await surface.focus();
  await surface.press("ArrowLeft");
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
});

test("PDF search finds real text, rejects stale queries, and distinguishes image-only text absence", async ({
  application,
}) => {
  const { ui } = await openReader(application, "Sample PDF");
  await ui.getByRole("region", { name: "Reading surface" }).press("/");
  const query = ui.getByRole("searchbox", { name: "Search text" });
  await query.fill("lantern");
  await expect(ui.locator("#search-status")).toHaveText("6 matches");
  await query.press("Enter");
  await expect
    .poll(() =>
      ui
        .locator(".textLayer")
        .evaluate(
          () =>
            [...(CSS.highlights.get("reader-search") ?? [])][0]?.startOffset,
        ),
    )
    .toBe(0);
  await query.press("Enter");
  await expect
    .poll(() =>
      ui
        .locator(".textLayer")
        .evaluate(
          () =>
            [...(CSS.highlights.get("reader-search") ?? [])][0]?.startOffset,
        ),
    )
    .toBe(8);
  await query.fill("CEDAR");
  await query.fill("HARBOR");
  await expect(ui.locator("#search-status")).toHaveText("1 matches");
  await query.press("Enter");
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await expect
    .poll(() =>
      ui
        .locator(".textLayer")
        .evaluate(() => CSS.highlights.get("reader-search")?.size ?? 0),
    )
    .toBe(1);
  await query.fill("missing phrase");
  await expect(ui.locator("#search-status")).toHaveText("No matches");
  await query.press("Escape");
  await expect(
    ui.getByRole("region", { name: "Reading surface" }),
  ).toBeFocused();
  const { ui: image } = await openReader(application, "Image-only PDF");
  await image.getByRole("button", { name: "Search", exact: true }).click();
  await image.getByRole("searchbox").fill("ORCHID");
  await expect(image.locator("#search-status")).toHaveText(
    "Text unavailable in this book",
  );
});

test("EPUB chapter, percentage, arrows and search use actual content", async ({
  application,
}) => {
  const { reader, ui } = await openReader(application, "Sample EPUB");
  await ui
    .getByRole("combobox", { name: "Contents" })
    .selectOption({ label: "Harbor" });
  await expect
    .poll(async () => {
      try {
        return await chapter(reader).locator("body").textContent();
      } catch {
        return "";
      }
    })
    .toContain("HARBOR EPUB SECOND");
  await chapter(reader).locator("body").press("ArrowRight");
  await expect(chapter(reader).locator("body")).toContainText(
    "HARBOR EPUB SECOND",
  );
  const jump = ui.getByRole("textbox", { name: "Jump" });
  await jump.fill("101%");
  await jump.press("Enter");
  await expect(ui.getByRole("alert")).toContainText("0–100%");
  await jump.fill("99.9%");
  await jump.press("Enter");
  await expect
    .poll(async () => {
      try {
        return await chapter(reader).locator("body").textContent();
      } catch {
        return "";
      }
    })
    .toContain("HARBOR EPUB SECOND");
  await jump.fill("0%");
  await jump.press("Enter");
  await expect
    .poll(async () => {
      try {
        return await chapter(reader).locator("body").textContent();
      } catch {
        return "";
      }
    })
    .toContain("ORCHID EPUB FIRST");
  await ui.getByRole("button", { name: "Search", exact: true }).click();
  const query = ui.getByRole("searchbox");
  await query.fill("LANTERN PASSAGE 24.");
  await expect(ui.locator("#search-status")).toHaveText("1 matches");
  await query.press("Enter");
  await expect
    .poll(() =>
      chapter(reader).evaluate(() => document.getSelection()?.toString()),
    )
    .toContain("LANTERN PASSAGE 24.");
  await ui.getByRole("spinbutton", { name: "Font size" }).fill("22");
  await ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
  await reader
    .locator('iframe[title="Book content"]')
    .evaluate((frame: HTMLIFrameElement) => {
      frame.style.height = "400px";
    });
  await expect
    .poll(() =>
      chapter(reader).evaluate(() => document.getSelection()?.toString()),
    )
    .toContain("LANTERN PASSAGE 24.");
  await query.press("Escape");
  await expect(
    ui.getByRole("region", { name: "Reading surface" }),
  ).toBeFocused();
  await expect
    .poll(() =>
      chapter(reader).evaluate(() => document.getSelection()?.toString()),
    )
    .toBe("");
});

test("PDF fit, zoom and pan stay within one physical page and snapshot restores them", async ({
  application,
}) => {
  const { reader, ui } = await openReader(application, "Sample PDF");
  const surface = ui.getByRole("region", { name: "Reading surface" });
  const zoom = ui.getByRole("spinbutton", { name: "Zoom" });
  await zoom.fill("3");
  await zoom.press("Tab");
  await expect
    .poll(() =>
      surface.evaluate(
        (el) =>
          el.scrollHeight > el.clientHeight && el.scrollWidth > el.clientWidth,
      ),
    )
    .toBe(true);
  await surface.hover();
  await reader.mouse.wheel(100, 120);
  await expect
    .poll(() => surface.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await ui.getByText("Diagnostic location snapshot", { exact: true }).click();
  await ui.getByRole("button", { name: "Capture snapshot" }).click();
  await expect(ui.getByRole("textbox", { name: "Snapshot" })).toHaveValue(
    /"revision"/,
  );
  const saved = await ui
    .getByRole("textbox", { name: "Snapshot" })
    .inputValue();
  expect(JSON.parse(saved).location.y).toBeGreaterThan(0);
  await ui.getByRole("button", { name: "Fit page", exact: true }).click();
  await expect
    .poll(() =>
      surface.evaluate(
        (el) =>
          el.scrollHeight <= el.clientHeight + 1 &&
          el.scrollWidth <= el.clientWidth + 1,
      ),
    )
    .toBe(true);
  await ui.getByRole("button", { name: "Restore snapshot" }).click();
  await expect(ui.getByRole("status")).toContainText("exact restoration");
  await expect(zoom).toHaveValue("3");
  await expect
    .poll(() => surface.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
});

test("EPUB keeps a known passage after font/viewport changes and a real process restart", async ({
  application,
}) => {
  const { reader, ui } = await openReader(application, "Sample EPUB");
  await ui.getByRole("button", { name: "Search", exact: true }).click();
  const query = ui.getByRole("searchbox");
  await query.fill("LANTERN PASSAGE 24.");
  await expect(ui.locator("#search-status")).toHaveText("1 matches");
  await query.press("Enter");
  await query.press("Escape");
  await expect(ui.getByTestId("visible-text")).toContainText(
    "LANTERN PASSAGE 24.",
  );
  await ui.getByRole("spinbutton", { name: "Font size" }).fill("24");
  await ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
  await reader
    .locator('iframe[title="Book content"]')
    .evaluate((frame: HTMLIFrameElement) => {
      frame.style.width = "640px";
      frame.style.height = "460px";
    });
  await ui.getByText("Diagnostic location snapshot", { exact: true }).click();
  await ui.getByRole("button", { name: "Capture snapshot" }).click();
  const snapshot = ui.getByRole("textbox", { name: "Snapshot" });
  await expect(snapshot).toHaveValue(/"fontSize":24/);
  await expect(ui.getByTestId("visible-text")).toContainText(
    "LANTERN PASSAGE 24.",
  );
  const saved = await snapshot.inputValue();
  const profile = await application.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const savedPath = join(profile, "engine-snapshot.json");
  await writeFile(savedPath, saved);
  await application.close();
  const restarted = await electron.launch({
    args: ["."],
    env: { ...process.env, BORGES_DEV_PROFILE: profile },
  });
  try {
    const { ui: restored } = await openReader(restarted, "Sample EPUB");
    await restored
      .getByText("Diagnostic location snapshot", { exact: true })
      .click();
    await restored
      .getByRole("textbox", { name: "Snapshot" })
      .fill(await readFile(savedPath, "utf8"));
    await restored.getByRole("button", { name: "Restore snapshot" }).click();
    await expect(restored.getByRole("status")).toContainText(
      "exact restoration",
    );
    await expect(restored.getByTestId("visible-text")).toContainText(
      "LANTERN PASSAGE 24.",
    );
    await expect(
      restored.getByRole("spinbutton", { name: "Font size" }),
    ).toHaveValue("24");
    const damaged = JSON.parse(saved);
    damaged.location.cfi = "broken locator";
    await restored
      .getByRole("textbox", { name: "Snapshot" })
      .fill(JSON.stringify(damaged));
    await restored.getByRole("button", { name: "Restore snapshot" }).click();
    await expect(restored.getByRole("status")).toContainText(
      "approximate restoration",
    );
    await expect(restored.locator("#location")).toContainText("Chapter 1");
    await expect(restored.getByTestId("visible-text")).not.toContainText(
      "ORCHID EPUB FIRST",
    );
    damaged.revision = "different revision";
    await restored
      .getByRole("textbox", { name: "Snapshot" })
      .fill(JSON.stringify(damaged));
    await restored.getByRole("button", { name: "Restore snapshot" }).click();
    await expect(restored.getByRole("alert")).toContainText(
      "different document revision",
    );
  } finally {
    await restarted.close();
  }
});

test("fixed EPUB remains single page during chapter/percentage navigation and zoom", async ({
  application,
}) => {
  const { reader, ui } = await openReader(application, "Fixed EPUB");
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(async () => {
      try {
        return await chapter(reader).locator("body").textContent();
      } catch {
        return "";
      }
    })
    .toContain("HARBOR EPUB SECOND");
  await expect
    .poll(
      () =>
        reader
          .frames()
          .filter((frame) => frame.url().startsWith("blob:borges://reader/"))
          .length,
    )
    .toBe(1);
  const jump = ui.getByRole("textbox", { name: "Jump" });
  await jump.fill("99.9%");
  await jump.press("Enter");
  await expect
    .poll(async () => {
      try {
        return await chapter(reader).locator("body").textContent();
      } catch {
        return "";
      }
    })
    .toContain("HARBOR EPUB SECOND");
  await jump.fill("0%");
  await jump.press("Enter");
  await expect
    .poll(async () => {
      try {
        return await chapter(reader).locator("body").textContent();
      } catch {
        return "";
      }
    })
    .toContain("ORCHID EPUB FIRST");
  const zoom = ui.getByRole("spinbutton", { name: "Zoom" });
  await zoom.fill("3");
  await zoom.press("Tab");
  await ui.getByText("Diagnostic location snapshot", { exact: true }).click();
  await ui.getByRole("button", { name: "Capture snapshot" }).click();
  await expect(ui.getByRole("textbox", { name: "Snapshot" })).toHaveValue(
    /"zoom":3/,
  );
  await expect
    .poll(
      () =>
        reader
          .frames()
          .filter((frame) => frame.url().startsWith("blob:borges://reader/"))
          .length,
    )
    .toBe(1);
  await chapter(reader).locator("body").hover();
  await reader.mouse.wheel(160, 240);
  await ui.getByRole("button", { name: "Capture snapshot" }).click();
  await expect
    .poll(
      async () =>
        JSON.parse(
          await ui.getByRole("textbox", { name: "Snapshot" }).inputValue(),
        ).location.y,
    )
    .toBeGreaterThan(0);
});

test("PDF outline/internal links and physical location restore after restart", async ({
  application,
}) => {
  const { ui } = await openReader(application, "Sample PDF");
  await ui.getByRole("button", { name: "Go to page 2", exact: true }).click();
  await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
  await ui
    .getByRole("combobox", { name: "Contents" })
    .selectOption({ label: "Harbor" });
  await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await ui.getByText("Diagnostic location snapshot", { exact: true }).click();
  await ui.getByRole("button", { name: "Capture snapshot" }).click();
  const input = ui.getByRole("textbox", { name: "Snapshot" });
  await expect(input).toHaveValue(/"page":3/);
  const profile = await application.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  await writeFile(join(profile, "pdf-snapshot.json"), await input.inputValue());
  await application.close();
  const restarted = await electron.launch({
    args: ["."],
    env: { ...process.env, BORGES_DEV_PROFILE: profile },
  });
  try {
    const { ui: restored } = await openReader(restarted, "Sample PDF");
    await restored
      .getByText("Diagnostic location snapshot", { exact: true })
      .click();
    await restored
      .getByRole("textbox", { name: "Snapshot" })
      .fill(await readFile(join(profile, "pdf-snapshot.json"), "utf8"));
    await restored.getByRole("button", { name: "Restore snapshot" }).click();
    await expect(restored.getByRole("status")).toContainText(
      "exact restoration",
    );
    await expect(restored.getByTestId("page-text")).toContainText(
      "HARBOR THIRD",
    );
  } finally {
    await restarted.close();
  }
});
