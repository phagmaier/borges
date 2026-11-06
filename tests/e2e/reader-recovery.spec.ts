import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  acknowledged,
  catalog,
  openCatalogReader,
  stored,
  value,
} from "./catalog";
import { expect, launch, test } from "./desktop";

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
    ],
  },
});

for (const action of ["close", "Quit"] as const) {
  test(`${action} waits for queued page turns before flushing`, async ({
    application,
    profile,
    seeded,
  }) => {
    const { reader, ui } = await openCatalogReader(application, "Known PDF");
    await acknowledged(reader);
    await ui.locator("#surface").evaluate((surface) => {
      // Delay the real PDF engine's render frames while two turns are queued.
      const win = surface.ownerDocument.defaultView;
      if (!win) throw new Error("Missing content window");
      const raf = win.requestAnimationFrame.bind(win);
      win.requestAnimationFrame = (callback) =>
        raf((time) => {
          win.setTimeout(() => callback(time), 400);
        });
      const next =
        surface.ownerDocument.querySelector<HTMLButtonElement>("#next");
      if (!next) throw new Error("Missing Next control");
      next.click();
      next.click();
    });
    expect(stored(profile, seeded["Known PDF"] as string).page).toBe(1);
    if (action === "close") {
      // BrowserWindow.close exercises the native close event (Page.close can
      // destroy a target directly and bypass the application's close policy).
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle().startsWith("Known PDF"))
          ?.close();
      });
      await expect.poll(() => reader.isClosed()).toBe(true);
    } else {
      const exited = new Promise((resolve) =>
        application.process().once("exit", resolve),
      );
      await reader.evaluate(() => window.development.quit());
      await exited;
    }
    expect(stored(profile, seeded["Known PDF"] as string).page).toBe(3);
  });
}

test("a failed save stays visibly unsaved, retries without navigation and leaves other readers usable", async ({
  application,
  profile,
  seeded,
}) => {
  const first = await openCatalogReader(application, "Known PDF");
  const second = await openCatalogReader(application, "Reflowable EPUB");
  await acknowledged(first.reader);
  const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
  try {
    db.exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON reader_settings
      WHEN NEW.book_id = '${seeded["Known PDF"]}'
      BEGIN SELECT RAISE(ABORT, 'disk full test'); END`);
    await first.ui.getByRole("button", { name: "Next", exact: true }).click();
    await expect(first.reader.getByRole("alert")).toContainText(
      "disk full test",
    );
    await expect(first.reader.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "error",
    );
    await first.reader.screenshot({
      path: test.info().outputPath("save-error.png"),
    });
    expect(stored(profile, seeded["Known PDF"] as string).page).toBe(1);
    await second.ui.getByRole("spinbutton", { name: "Font size" }).fill("26");
    await second.ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
    await expect
      .poll(() => stored(profile, seeded["Reflowable EPUB"] as string).fontSize)
      .toBe(26);
    db.exec("DROP TRIGGER fail_progress");
    await first.reader.getByRole("button", { name: "Retry saving" }).click();
    await expect(first.reader.getByRole("alert")).toHaveCount(0);
    await expect(first.reader.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    expect(stored(profile, seeded["Known PDF"] as string).page).toBe(2);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_progress");
    db.close();
  }
});

// A long coalescing interval makes the acknowledged/uncommitted boundary
// deterministic; killing the real main process cannot run a close flush.
test.describe("unexpected termination", () => {
  test.use({ environment: { BORGES_SAVE_INTERVAL_MS: "10000" } });
  test("SIGKILL resumes the last acknowledged position and per-book sizing", async ({
    application,
    profile,
    seeded,
  }) => {
    const { reader, ui } = await openCatalogReader(application, "Known PDF");
    await ui.getByRole("button", { name: "Next", exact: true }).click();
    await ui.getByRole("spinbutton", { name: "Zoom" }).fill("1.5");
    await ui.getByRole("spinbutton", { name: "Zoom" }).press("Tab");
    // Establish a committed checkpoint without displaying routine save controls.
    await reader.evaluate(() => window.borges.reader.flush());
    await acknowledged(reader);
    expect(stored(profile, seeded["Known PDF"] as string).page).toBe(2);
    await ui.getByRole("button", { name: "Next", exact: true }).click();
    await expect(ui.locator("#location")).toHaveText("Page 3 of 3");
    await expect(reader.getByTestId("save-status")).toHaveAttribute(
      "data-state",
      "pending",
    );
    const exited = new Promise((resolve) =>
      application.process().once("exit", resolve),
    );
    application.process().kill("SIGKILL");
    await exited;
    const restarted = await launch(profile);
    try {
      const again = await openCatalogReader(restarted, "Known PDF");
      await expect(again.ui.getByTestId("page-text")).toContainText(
        "CEDAR SECOND",
      );
      await expect(
        again.ui.getByRole("spinbutton", { name: "Zoom" }),
      ).toHaveValue("1.5");
      await expect(again.reader.getByTestId("restoration-notice")).toHaveCount(
        0,
      );
    } finally {
      await restarted.close();
    }
  });
});

for (const action of ["close", "Quit"] as const) {
  test(`${action} preserves a reader after save failure and allows an explicit discard`, async ({
    application,
    profile,
    seeded,
  }) => {
    // Capture a healthy earlier reader before the failing one during Quit;
    // cancelling Quit must resume both, without retiring either session.
    const other =
      action === "Quit"
        ? await openCatalogReader(application, "Reflowable EPUB")
        : null;
    const { reader, ui } = await openCatalogReader(application, "Known PDF");
    await acknowledged(reader);
    const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
    try {
      db.exec(
        `CREATE TRIGGER fail_close BEFORE INSERT ON reader_settings WHEN NEW.book_id = '${seeded["Known PDF"]}' BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`,
      );
      await ui.getByRole("button", { name: "Next", exact: true }).click();
      await expect(reader.getByRole("alert")).toContainText(
        "storage unavailable",
      );
      await application.evaluate(({ dialog }) => {
        const state = globalThis as typeof globalThis & {
          closeDialogs: number;
          discard: boolean;
        };
        state.closeDialogs = 0;
        state.discard = false;
        dialog.showMessageBox = (async (_options: unknown) => {
          state.closeDialogs += 1;
          return { response: state.discard ? 1 : 0, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      });
      async function requestClose() {
        if (action === "Quit")
          await reader.evaluate(() => window.development.quit());
        else
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((w) => w.getTitle().startsWith("Known PDF"))
              ?.close(),
          );
      }
      await requestClose();
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { closeDialogs: number })
                .closeDialogs,
          ),
        )
        .toBe(1);
      expect(reader.isClosed()).toBe(false);
      expect(stored(profile, seeded["Known PDF"] as string).page).toBe(1);
      // Keeping the reader open restores keyboard/control use after draining.
      if (other) {
        await other.ui
          .getByRole("spinbutton", { name: "Font size" })
          .fill("27");
        await other.ui
          .getByRole("spinbutton", { name: "Font size" })
          .press("Tab");
        await expect
          .poll(
            () => stored(profile, seeded["Reflowable EPUB"] as string).fontSize,
          )
          .toBe(27);
      }
      await ui.getByRole("button", { name: "Next", exact: true }).click();
      await expect(ui.locator("#location")).toHaveText("Page 3 of 3");
      await application.evaluate(() => {
        (globalThis as typeof globalThis & { discard: boolean }).discard = true;
      });
      const nativeProcess = application.process();
      await requestClose();
      if (action === "close")
        await expect.poll(() => reader.isClosed()).toBe(true);
      else await expect.poll(() => nativeProcess.exitCode).toBe(0);
      expect(stored(profile, seeded["Known PDF"] as string).page).toBe(1);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_close");
      db.close();
    }
  });
}

test("ordinary navigation is acknowledged within one second and invalid saved PDF pages explain the restart", async ({
  application,
  profile,
  seeded,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Known PDF");
  await acknowledged(reader);
  const start = Date.now();
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(() => stored(profile, seeded["Known PDF"] as string).page, {
      intervals: [10],
    })
    .toBe(2);
  await expect(reader.getByTestId("save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  expect(Date.now() - start).toBeLessThan(1000);
  await application.close();
  const db = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
  db.prepare("UPDATE positions SET pdf_page = 999 WHERE revision_id = ?").run(
    stored(profile, seeded["Known PDF"] as string).revision,
  );
  db.close();
  const restarted = await launch(profile);
  try {
    const again = await openCatalogReader(restarted, "Known PDF");
    await expect(again.ui.getByTestId("page-text")).toContainText(
      "ORCHID FIRST",
    );
    await expect(again.reader.getByTestId("restoration-notice")).toContainText(
      "reading starts at the beginning",
    );
  } finally {
    await restarted.close();
  }
});

for (const action of ["replacement", "deletion"] as const) {
  test(`${action} drains queued turns before retiring the old revision`, async ({
    application,
    profile,
    seeded,
  }) => {
    const { library, ui } = await openCatalogReader(application, "Known PDF");
    const id = seeded["Known PDF"] as string;
    const revision = stored(profile, id).revision;
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, resolve("tests/fixtures/reader-corpus.pdf"));
    await ui.locator("#surface").evaluate((surface) => {
      const win = surface.ownerDocument.defaultView;
      const next =
        surface.ownerDocument.querySelector<HTMLButtonElement>("#next");
      if (!win || !next) throw new Error("Missing reader controls");
      const raf = win.requestAnimationFrame.bind(win);
      win.requestAnimationFrame = (callback) =>
        raf((time) => {
          win.setTimeout(() => callback(time), 400);
        });
      next.click();
      next.click();
    });
    await value(
      library,
      action === "replacement" ? "replaceFile" : "deleteBook",
      id,
    );
    expect(
      catalog(
        profile,
        (db) =>
          db
            .prepare("SELECT pdf_page FROM positions WHERE revision_id = ?")
            .get(revision)?.pdf_page,
      ),
    ).toBe(3);
  });
}

test("a PDF rendering failure keeps the last working position and Retry reader recreates the engine", async ({
  application,
  profile,
  seeded,
}) => {
  const { reader, ui } = await openCatalogReader(application, "Known PDF");
  await acknowledged(reader);
  await ui.locator("#surface").evaluate((surface) => {
    const win = surface.ownerDocument.defaultView;
    if (!win) throw new Error("Missing reader window");
    Object.defineProperty(win.HTMLCanvasElement.prototype, "getContext", {
      value: () => {
        throw new Error("render failure test");
      },
    });
  });
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect(reader.getByRole("alert")).toContainText("render failure test");
  await reader.evaluate(() => window.borges.reader.flush());
  expect(stored(profile, seeded["Known PDF"] as string).page).toBe(1);
  await reader.getByRole("button", { name: "Retry reader" }).click();
  await expect(ui.getByRole("status")).toHaveText("Ready");
  await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  expect(stored(profile, seeded["Known PDF"] as string).page).toBe(1);
  await ui.getByRole("button", { name: "Next", exact: true }).click();
  await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
});
