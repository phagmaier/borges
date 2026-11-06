import type { BrowserWindow } from "electron";
import { acknowledged, openCatalogReader, stored } from "./catalog";
import { expect, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
    ],
  },
});

// Playwright marks an entire Page crashed when its out-of-process iframe dies,
// even though the shell survives. After the kill use Electron's real window /
// frame APIs to inspect and click the surviving UI. No test-only app endpoint.
async function content(window: BrowserWindow, code: string) {
  const frame = window.webContents.mainFrame.frames.find(
    (f) => !f.isDestroyed() && f.url.startsWith("borges://reader-"),
  );
  if (!frame) return null;
  return frame.executeJavaScript(code);
}

test.afterEach(async ({ application }) => {
  // Quit cases have already exited; the fixture owns final process cleanup.
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
});

test("a killed book process leaves the other reader usable and offers explicit recovery", async ({
  application,
  profile,
  seeded,
}) => {
  const first = await openCatalogReader(application, "Known PDF");
  const second = await openCatalogReader(application, "Reflowable EPUB");
  await first.ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(() => stored(profile, seeded["Known PDF"] as string).page)
    .toBe(2);
  await acknowledged(first.reader);
  const before = stored(profile, seeded["Known PDF"] as string);
  const native = await application.browserWindow(first.reader);
  const processes = await application.evaluate(({ BrowserWindow }) => {
    const readers = ["Known PDF", "Reflowable EPUB"].map((title) => {
      const contents = BrowserWindow.getAllWindows().find((w) =>
        w.getTitle().startsWith(title),
      )?.webContents;
      const frame = contents?.mainFrame.frames.find((f) =>
        f.url.startsWith("borges://reader-"),
      );
      if (!frame) throw new Error("Missing book frame");
      return { pid: frame.osProcessId, shell: contents?.getOSProcessId() };
    });
    process.kill(readers[0]?.pid as number, "SIGKILL");
    return readers;
  });
  expect(processes[0]?.pid).not.toBe(processes[1]?.pid);
  expect(processes[0]?.pid).not.toBe(processes[0]?.shell);
  await expect
    .poll(() =>
      native.evaluate((w) =>
        w.webContents.executeJavaScript(
          'document.querySelector(".reader-error")?.textContent',
        ),
      ),
    )
    .toContain("book process stopped");
  await native.evaluate(async (w, path) => {
    process
      .getBuiltinModule("fs")
      .writeFileSync(path, (await w.capturePage()).toPNG());
  }, test.info().outputPath("crashed-book.png"));
  await second.ui.getByRole("spinbutton", { name: "Font size" }).fill("26");
  await second.ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
  await expect
    .poll(() => stored(profile, seeded["Reflowable EPUB"] as string).fontSize)
    .toBe(26);
  // There is no automatic regrant/reload loop while the failure is visible.
  expect(stored(profile, seeded["Known PDF"] as string)).toEqual(before);
  await native.evaluate((w) =>
    w.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Retry reader").click()',
    ),
  );
  await expect
    .poll(() =>
      native.evaluate(
        content,
        'document.querySelector("[data-testid=page-text]")?.textContent',
      ),
    )
    .toContain("CEDAR SECOND");
  await expect
    .poll(() => stored(profile, seeded["Known PDF"] as string).generation)
    .toBeGreaterThan(before.generation);
  const code = await native.evaluate(
    (w, report) =>
      w.webContents.executeJavaScript(`new Promise(resolve => {
      const stop = window.borges.reader.onProgressResult(result => {
        if (result.generation === ${report.generation}) { stop(); resolve(result.code); }
      });
      window.borges.reader.reportProgress(${JSON.stringify(report)});
    })`),
    {
      bookId: seeded["Known PDF"],
      revisionId: before.revision,
      generation: before.generation,
      sequence: 100000,
      location: { format: "pdf", page: 1, x: 0, y: 0 },
      sizing: { fontSize: 18, zoom: 1 },
    },
  );
  expect(code).toBe("stale-session");
  expect(stored(profile, seeded["Known PDF"] as string).page).toBe(2);
  await native.evaluate(content, 'document.querySelector("#next").click()');
  await expect
    .poll(() => stored(profile, seeded["Known PDF"] as string).page)
    .toBe(3);
  expect(
    await second.ui.getByRole("spinbutton", { name: "Font size" }).inputValue(),
  ).toBe("26");
});

test.describe("reported but uncommitted state", () => {
  test.use({ environment: { BORGES_SAVE_INTERVAL_MS: "10000" } });
  for (const action of ["close", "Quit"] as const) {
    test(`a killed EPUB can ${action} while preserving positions already received by main`, async ({
      application,
      profile,
      seeded,
    }) => {
      const { reader, ui } = await openCatalogReader(
        application,
        "Reflowable EPUB",
      );
      // Observe the real IPC report; a pending initial-open report is not
      // evidence that the asynchronous font command has reached main.
      await application.evaluate(({ ipcMain }) => {
        const observe = (
          _: unknown,
          report: { sizing?: { fontSize?: number } },
        ) => {
          if (report.sizing?.fontSize === 31) {
            Reflect.set(globalThis, "crashTestFontReceived", true);
            ipcMain.off("reader:progress", observe);
          }
        };
        ipcMain.on("reader:progress", observe);
      });
      await ui.getByRole("spinbutton", { name: "Font size" }).fill("31");
      await ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
      await expect(reader.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "pending",
      );
      await expect
        .poll(() =>
          application.evaluate(() =>
            Reflect.get(globalThis, "crashTestFontReceived"),
          ),
        )
        .toBe(true);
      const native = await application.browserWindow(reader);
      const nativeProcess = application.process();
      await native.evaluate((w: BrowserWindow) => {
        const frame = w.webContents.mainFrame.frames.find((f) =>
          f.url.startsWith("borges://reader-"),
        );
        if (!frame) throw new Error("Missing book frame");
        process.kill(frame.osProcessId, "SIGKILL");
      });
      await expect
        .poll(() =>
          native.evaluate((w) =>
            w.webContents.executeJavaScript(
              'document.querySelector(".reader-error")?.textContent',
            ),
          ),
        )
        .toContain("book process stopped");
      if (action === "close") {
        await native.evaluate((w) => w.close());
        await expect.poll(() => reader.isClosed()).toBe(true);
      } else {
        await native.evaluate((w) =>
          w.webContents.executeJavaScript("window.development.quit()"),
        );
        await expect.poll(() => nativeProcess.exitCode).toBe(0);
      }
      expect(
        stored(profile, seeded["Reflowable EPUB"] as string).fontSize,
      ).toBe(31);
    });
  }
});
