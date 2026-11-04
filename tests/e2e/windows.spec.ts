import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "./desktop";

test("reader shells are unique per book and outlive the library", async ({
  application,
}) => {
  const nativeProcess = application.process();
  const library = await application.firstWindow();
  await expect(
    library.getByRole("button", { name: "Open Sample PDF" }),
  ).toBeVisible();
  const [pdf] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() =>
      Promise.all([
        window.development.openReader("sample-pdf"),
        window.development.openReader("sample-pdf"),
      ]),
    ),
  ]);
  await expect(
    pdf.getByRole("heading", { name: "Sample PDF", exact: true }),
  ).toBeVisible();
  const epubOpened = application.waitForEvent("window");
  await library.getByRole("button", { name: "Open Sample EPUB" }).click();
  const epub = await epubOpened;
  await expect(
    epub.getByRole("heading", { name: "Sample EPUB", exact: true }),
  ).toBeVisible();
  const pdfWindow = await application.browserWindow(pdf);
  expect(await pdfWindow.evaluate((window) => window.getTitle())).toBe(
    "Sample PDF — reader shell",
  );
  for (const reader of [pdf, epub]) {
    expect(
      await reader.evaluate(() => window.development.getRuntimeInfo()),
    ).toMatchObject({
      sandboxed: true,
      contextIsolated: true,
    });
    expect(
      await reader.evaluate(() => typeof Reflect.get(globalThis, "require")),
    ).toBe("undefined");
  }
  expect(application.windows()).toHaveLength(3);

  // Reopen through the awaited bridge so the count is checked after coordination.
  await library.evaluate(async () => {
    const api = window.development;
    await Promise.all([
      api.openReader("sample-pdf"),
      api.openReader("sample-pdf"),
    ]);
  });
  expect(application.windows()).toHaveLength(3);
  await pdf.reload();
  await expect(
    pdf.getByRole("heading", { name: "Sample PDF", exact: true }),
  ).toBeVisible();

  await library.close();
  expect(application.windows()).toHaveLength(2);
  const libraryReopened = application.waitForEvent("window");
  await epub.getByRole("button", { name: "Open library", exact: true }).click();
  const reopened = await libraryReopened;
  await expect(
    reopened.getByRole("heading", {
      name: "Development environment",
      exact: true,
    }),
  ).toBeVisible();
  await pdf.evaluate(async () => {
    await window.development.openLibrary();
  });
  expect(application.windows()).toHaveLength(3);

  await pdf.close();
  const newPdfOpened = application.waitForEvent("window");
  await reopened.getByRole("button", { name: "Open Sample PDF" }).click();
  const newPdf = await newPdfOpened;
  await expect(
    newPdf.getByRole("heading", { name: "Sample PDF", exact: true }),
  ).toBeVisible();
  await reopened.close();
  await epub.close();
  const exited = application.waitForEvent("close");
  await newPdf.close();
  await exited;
  await expect.poll(() => nativeProcess.exitCode).toBe(0);
});

test("a second launch reopens the existing instance's library", async ({
  application,
}) => {
  const library = await application.firstWindow();
  await expect(
    library.getByRole("button", { name: "Open Sample PDF" }),
  ).toBeVisible();
  await library.evaluate(() => window.development.openReader("sample-pdf"));
  await library.close();
  const profile = await application.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const reopened = application.waitForEvent("window");
  const secondary = spawn(application.process().spawnfile, ["."], {
    env: { ...process.env, BORGES_DEV_PROFILE: profile },
    stdio: "ignore",
  });
  try {
    const [page, [code]] = await Promise.all([
      reopened,
      once(secondary, "exit"),
    ]);
    expect(code).toBe(0);
    await expect(
      page.getByRole("heading", {
        name: "Development environment",
        exact: true,
      }),
    ).toBeVisible();
    expect(application.windows()).toHaveLength(2);
  } finally {
    if (secondary.exitCode === null) secondary.kill();
  }
});

// Narrowed second-launch contract (spec): an open library is reused and asked
// to activate; granting focus is compositor policy, as for reader reopening.
test("a second launch reuses an open library and requests its activation", async ({
  application,
}) => {
  const library = await application.firstWindow();
  await expect(
    library.getByRole("button", { name: "Open Sample PDF" }),
  ).toBeVisible();
  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-pdf")),
  ]);
  await expect(
    reader.getByRole("heading", { name: "Sample PDF", exact: true }),
  ).toBeVisible();
  const libraryWindow = await application.browserWindow(library);
  const before = await libraryWindow.evaluate((window) => {
    const counted = window as typeof window & { activationRequests?: number };
    counted.activationRequests = 0;
    const focus = window.focus.bind(window);
    window.focus = () => {
      counted.activationRequests = (counted.activationRequests ?? 0) + 1;
      focus();
    };
    return { id: window.id, contents: window.webContents.id };
  });
  let created = 0;
  application.on("window", () => created++);
  const profile = await application.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const secondary = spawn(application.process().spawnfile, ["."], {
    env: { ...process.env, BORGES_DEV_PROFILE: profile },
    stdio: "ignore",
  });
  try {
    const [code] = await once(secondary, "exit");
    expect(code).toBe(0);
    await expect
      .poll(() =>
        libraryWindow.evaluate(
          (window) =>
            (window as typeof window & { activationRequests?: number })
              .activationRequests,
        ),
      )
      .toBe(1);
    expect(
      await libraryWindow.evaluate((window) => ({
        id: window.id,
        contents: window.webContents.id,
        visible: window.isVisible(),
      })),
    ).toEqual({ ...before, visible: true });
    expect(created).toBe(0);
    expect(application.windows()).toHaveLength(2);
  } finally {
    if (secondary.exitCode === null) secondary.kill();
  }
});

test("a reader load failure removes its reservation and allows retry", async ({
  application,
}) => {
  const library = await application.firstWindow();
  await expect(
    library.getByRole("button", { name: "Open Sample PDF" }),
  ).toBeVisible();
  await application.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["borges://app/*"] },
      (_, callback) => callback({ cancel: true }),
    );
  });
  expect(
    await library.evaluate(async () => {
      try {
        await window.development.openReader("sample-pdf");
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }),
  ).toContain("ERR_BLOCKED_BY_CLIENT");
  await expect.poll(() => application.windows().length).toBe(1);
  await application.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(null);
  });
  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-pdf")),
  ]);
  await expect(
    reader.getByRole("heading", { name: "Sample PDF", exact: true }),
  ).toBeVisible();
  expect(application.windows()).toHaveLength(2);
});

// Narrowed M1-02 contract (spec, A5): reopening reuses the window and
// requests activation. Whether the compositor grants it is desktop policy;
// Hyprland with misc:focus_on_activate=false answers with an urgency hint.
test("reopening an existing reader reuses its window and requests activation", async ({
  application,
}) => {
  const library = await application.firstWindow();
  await expect(
    library.getByRole("button", { name: "Open Sample PDF" }),
  ).toBeVisible();
  const [pdf] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-pdf")),
  ]);
  const pdfWindow = await application.browserWindow(pdf);
  await expect
    .poll(() => pdfWindow.evaluate((window) => window.isFocused()))
    .toBe(true);
  await library.evaluate(() => window.development.openReader("sample-epub"));
  await expect
    .poll(() => pdfWindow.evaluate((window) => window.isFocused()))
    .toBe(false);
  const before = await pdfWindow.evaluate((window) => {
    const counted = window as typeof window & { activationRequests?: number };
    counted.activationRequests = 0;
    const focus = window.focus.bind(window);
    window.focus = () => {
      counted.activationRequests = (counted.activationRequests ?? 0) + 1;
      focus();
    };
    return { id: window.id, contents: window.webContents.id };
  });
  let created = 0;
  application.on("window", () => created++);
  await library.evaluate(() => window.development.openReader("sample-pdf"));
  expect(created).toBe(0);
  expect(application.windows()).toHaveLength(3);
  expect(
    await pdfWindow.evaluate((window) => ({
      id: window.id,
      contents: window.webContents.id,
      visible: window.isVisible(),
      activationRequests: (
        window as typeof window & {
          activationRequests?: number;
        }
      ).activationRequests,
    })),
  ).toEqual({ ...before, visible: true, activationRequests: 1 });
  await expect(
    pdf.getByRole("heading", { name: "Sample PDF", exact: true }),
  ).toBeVisible();
});

test("window commands reject unknown books, reader impersonation, and unregistered senders", async ({
  application,
}) => {
  const library = await application.firstWindow();
  await expect(
    library.getByRole("button", { name: "Open Sample PDF" }),
  ).toBeVisible();
  expect(
    await library.evaluate(async () => {
      try {
        await window.development.openReader("unknown");
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }),
  ).toContain("Unknown diagnostic book");
  expect(application.windows()).toHaveLength(1);

  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-pdf")),
  ]);
  await expect(
    reader.getByRole("heading", { name: "Sample PDF", exact: true }),
  ).toBeVisible();
  expect(
    await reader.evaluate(async () => {
      location.hash = "library";
      try {
        await window.development.openReader("sample-epub");
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }),
  ).toContain("Readers must be opened from the library");
  expect(application.windows()).toHaveLength(2);

  const [unregistered] = await Promise.all([
    application.waitForEvent("window"),
    application.evaluate(async ({ BrowserWindow, app }) => {
      const { join } = process.getBuiltinModule("node:path");
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: join(app.getAppPath(), "out/preload/index.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await window.loadURL("borges://app/index.html");
    }),
  ]);
  expect(
    await unregistered.evaluate(async () => {
      try {
        await window.development.openLibrary();
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }),
  ).toContain("registered application window");
  await unregistered.close();

  await reader.getByRole("button", { name: "Quit application" }).waitFor();
  const exited = application.waitForEvent("close");
  await reader.getByRole("button", { name: "Quit application" }).click();
  await exited;
});
