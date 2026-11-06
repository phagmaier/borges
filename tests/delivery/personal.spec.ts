import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "@playwright/test";
import { seedCatalog } from "../e2e/desktop";

test("the relocated personal launcher keeps the real sandbox, desktop activation and independent reader saves", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "borges-delivery-native-"));
  const bundle = join(root, "Borges relocated space — 蘭");
  const profile = join(root, "profile");
  const libraryRoot = join(profile, "library");
  const env = {
    ...process.env,
    PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_DATA_HOME: join(profile, "data"),
    BORGES_LIBRARY_ROOT: "",
    BORGES_DEV_PROFILE: "/must-not-be-used",
    ELECTRON_RENDERER_URL: "http://127.0.0.1:1",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--throw-deprecation",
  };
  await cp(
    resolve(process.env.BORGES_DELIVERY_ARTIFACT || "dist/borges"),
    bundle,
    { recursive: true },
  );
  expect(
    JSON.parse(await readFile(join(bundle, "BUILD-INFO.json"), "utf8")),
  ).toMatchObject({
    application: "Borges",
    version: JSON.parse(await readFile(resolve("package.json"), "utf8"))
      .version,
    sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    electron: "45.2.1",
    pdfjs: "6.5.438",
    foliate: "78914aef4466eb960965702401634c2cb348e9b1",
    lockfileSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  await promisify(execFile)("desktop-file-validate", [
    join(bundle, "borges.desktop"),
  ]);
  for (const [name, author] of [
    ["fflate.LICENSE", "Arjun Barrett"],
    ["zip.js.LICENSE", "Gildas Lormeau"],
  ])
    expect(
      await readFile(
        join(bundle, "resources/app/notices", name as string),
        "utf8",
      ),
    ).toContain(author);
  await seedCatalog(profile, [
    { fixture: "known.pdf", name: "Known PDF.pdf" },
    { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
  ]);
  // Direct launch deliberately bypasses Playwright's Electron launcher, which
  // adds --no-sandbox. A browser-only CDP attachment does not change app flags.
  const child = spawn(
    join(bundle, "launch"),
    ["--library-root", libraryRoot, "--remote-debugging-port=0"],
    { env, cwd: "/", stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await expect
      .poll(() => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(stderr);
        return stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      })
      .toBeTruthy();
    browser = await chromium.connectOverCDP(
      stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] as string,
    );
    const context = browser.contexts()[0];
    if (!context) throw new Error("Missing application context");
    const browserSession = await browser.newBrowserCDPSession();
    // Electron's browser-only CDP attachment needs discovery to report new
    // BrowserWindows. Keep explicit wait deadlines so failures reach cleanup.
    await browserSession.send("Target.setDiscoverTargets", { discover: true });
    const library = context.pages()[0];
    if (!library) throw new Error("Missing library window");
    await expect(
      library.getByRole("heading", { name: "All Books", exact: true }),
    ).toBeVisible();
    await expect(
      library.getByRole("heading", { name: "Development", exact: true }),
    ).toHaveCount(0);
    await expect(
      library.getByRole("button", { name: "Open Sample PDF" }),
    ).toHaveCount(0);
    expect(
      await library.evaluate(() => window.development.getRuntimeInfo()),
    ).toMatchObject({
      diagnostic: false,
      sandboxed: true,
      contextIsolated: true,
      catalog: { root: libraryRoot },
    });
    expect(await library.title()).toBe("Borges");
    expect(await readFile(`/proc/${child.pid}/cmdline`, "utf8")).not.toContain(
      "--no-sandbox",
    );
    expect(
      await library.evaluate(() =>
        window.development.openReader("sample-pdf").then(
          () => "allowed",
          () => "denied",
        ),
      ),
    ).toBe("denied");
    const open = async (title: string) => {
      const [reader] = await Promise.all([
        context.waitForEvent("page", { timeout: 10_000 }),
        library
          .getByRole("list", { name: "Books" })
          .getByRole("button", { name: title, exact: true })
          .press("Enter"),
      ]);
      const ui = reader.frameLocator('iframe[title="Book content"]');
      await expect(ui.getByRole("status")).toHaveText("Ready");
      return { reader, ui };
    };
    const pdf = await open("Known PDF");
    const epub = await open("Reflowable EPUB");
    await pdf.ui
      .getByRole("button", { name: "Dark mode", exact: true })
      .click();
    await expect(
      pdf.ui.getByRole("button", { name: "Dark mode", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(pdf.reader.locator(".reader-window")).toHaveCSS(
      "color-scheme",
      "dark",
    );
    await pdf.ui.getByRole("button", { name: "Next", exact: true }).click();
    await expect(pdf.ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
    await epub.ui.getByRole("spinbutton", { name: "Font size" }).fill("26");
    await epub.ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
    const { processInfo } = await browserSession.send(
      "SystemInfo.getProcessInfo",
    );
    const renderers = processInfo.filter(
      (process) => process.type === "renderer",
    );
    expect(renderers.length).toBeGreaterThanOrEqual(5);
    for (const renderer of renderers) {
      const status = await readFile(`/proc/${renderer.id}/status`, "utf8");
      expect(status).toMatch(/^Seccomp:\s+2$/m);
      expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
    }
    // Register with the bundled Node runtime, then launch the real .desktop
    // entry through GLib while two readers outlive their library window.
    await library.screenshot({
      path: test.info().outputPath("personal-library.png"),
    });
    await library.close();
    const execute = promisify(execFile);
    await execute(
      join(bundle, "launch"),
      ["--library-root", libraryRoot, "--install-desktop"],
      { env },
    );
    const desktop = join(env.XDG_DATA_HOME, "applications/borges.desktop");
    await execute("desktop-file-validate", [desktop]);
    const [reopened] = await Promise.all([
      context.waitForEvent("page", { timeout: 10_000 }),
      execute("gio", ["launch", desktop], { env }),
    ]);
    await expect(
      reopened.getByRole("heading", { name: "All Books", exact: true }),
    ).toBeVisible();
    expect(context.pages()).toHaveLength(3);
    await pdf.reader
      .getByRole("button", { name: "Quit application", exact: true })
      .click();
    await expect.poll(() => child.exitCode).toBe(0);
    const { stored } = await import("../e2e/catalog");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(libraryRoot, "catalog.sqlite"), {
      readOnly: true,
    });
    const books = database.prepare("SELECT id, title FROM books").all();
    database.close();
    expect(
      stored(profile, String(books.find((b) => b.title === "Known PDF")?.id))
        .page,
    ).toBe(2);
    expect(
      stored(
        profile,
        String(books.find((b) => b.title === "Reflowable EPUB")?.id),
      ).fontSize,
    ).toBe(26);
    const savedTheme = new DatabaseSync(join(libraryRoot, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        savedTheme
          .prepare("SELECT theme FROM reader_settings WHERE book_id = ?")
          .get(String(books.find((b) => b.title === "Known PDF")?.id))?.theme,
      ).toBe("dark");
    } finally {
      savedTheme.close();
    }
    expect(await readdir(join(profile, "config"))).toContain("borges");
    await expect(
      readdir(
        join(bundle, "resources/app/out/renderer/reader-assets/fixtures"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await browser?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
