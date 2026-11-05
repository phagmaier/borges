import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { bookButton, catalog, openCatalogReader, value } from "./catalog";
import { expect, test } from "./desktop";

async function importFiles(
  app: ElectronApplication,
  page: Page,
  paths: string[],
  kind: "files" | "folder" = "files",
) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: paths,
    })) as typeof dialog.showOpenDialog;
  }, paths);
  await page
    .getByRole("button", {
      name: kind === "files" ? "Import files…" : "Import folder…",
    })
    .click();
}
const fixture = (name: string) => resolve("tests/fixtures", name);
const summary = (page: Page) =>
  page.getByRole("region", { name: "Import summary" });
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test("A1: imports mixed content offline, extracts metadata and decoded covers, refuses protected/corrupt books individually", async ({
  application,
  profile,
}) => {
  const library = await application.firstWindow();
  const names = [
    "import-metadata.pdf",
    "import-metadata.epub",
    "import-password.pdf",
    "import-empty-password.pdf",
    "import-drm.epub",
    "import-fake-font.epub",
    "import-corrupt.pdf",
    "import-bad-xml.epub",
    "import-bad-spine.epub",
    "import-bad-type.epub",
    "obfuscated.epub",
    "import-no-metadata.epub",
    "import-bad-cover.epub",
    "import-bad-metadata.epub",
    "import-bomb.epub",
    "import-forged-size.epub",
  ];
  const folder = join(profile, "Mixed");
  await mkdir(folder);
  const paths = names.map((name) => join(folder, name));
  await Promise.all(
    paths.map((path, i) => copyFile(fixture(names[i] as string), path)),
  );
  const before = await Promise.all(paths.map(hash));
  await importFiles(application, library, [folder], "folder");
  await expect(summary(library).getByTestId("import-counts")).toHaveText(
    "5 failed · 5 unsupported · 6 imported",
    { timeout: 20_000 },
  );
  expect(await Promise.all(paths.map(hash))).toEqual(before);
  await expect(summary(library)).toContainText(
    "Encrypted PDFs are not supported.",
  );
  await expect(summary(library)).toContainText(
    "DRM-protected EPUB content is not supported",
  );
  await expect(summary(library)).toContainText("could not be parsed");
  await expect(summary(library)).toContainText("Unparseable EPUB XML");
  await expect(summary(library)).toContainText("unsupported spine media type");
  await expect(summary(library)).toContainText("resource limits");
  await expect(summary(library)).toContainText(
    "Warning: Cover could not be extracted; a placeholder was used.",
  );
  await expect(summary(library)).toContainText(
    "Warning: title metadata could not be extracted; a fallback was used.",
  );
  const books = catalog(profile, (db) =>
    db
      .prepare(
        `SELECT b.title, b.cover_path, b.cover_manual, b.title_manual, r.original_filename, r.extracted_title, r.extracted_authors, r.extracted_subjects, r.extracted_cover_path FROM books b JOIN revisions r ON r.id = b.current_revision_id ORDER BY r.original_filename`,
      )
      .all(),
  );
  expect(books.map((b) => b.original_filename)).toEqual([
    "import-bad-cover.epub",
    "import-bad-metadata.epub",
    "import-metadata.epub",
    "import-metadata.pdf",
    "import-no-metadata.epub",
    "obfuscated.epub",
  ]);
  expect(
    books.find((b) => b.original_filename === "import-metadata.epub"),
  ).toMatchObject({
    title: "Garden Stories",
    title_manual: 0,
    cover_manual: 0,
    extracted_title: "Garden Stories",
    extracted_authors: '["Zora","Ana"]',
    extracted_subjects: '["Gardens","Fiction"]',
  });
  expect(
    books.find((b) => b.original_filename === "import-metadata.pdf"),
  ).toMatchObject({
    title: "Garden Atlas",
    extracted_authors: '["Zora","Ana"]',
    extracted_subjects: '["Maps","Travel"]',
  });
  expect(
    books.find((b) => b.original_filename === "import-no-metadata.epub"),
  ).toMatchObject({
    title: "import-no-metadata",
    extracted_title: null,
    extracted_authors: "[]",
    extracted_subjects: "[]",
    cover_path: null,
  });
  expect(
    books.find((b) => b.original_filename === "import-bad-cover.epub"),
  ).toMatchObject({ cover_path: null, extracted_cover_path: null });
  expect(
    books.find((b) => b.original_filename === "import-bad-metadata.epub"),
  ).toMatchObject({
    title: "import-bad-metadata",
    extracted_title: null,
    extracted_authors: '["Zora","Ana"]',
  });
  for (const name of ["import-metadata.pdf", "import-metadata.epub"]) {
    const book = books.find((b) => b.original_filename === name);
    expect(book?.cover_path).toMatch(/^covers\/.+\.png$/);
    expect(book?.extracted_cover_path).toBe(book?.cover_path);
    const button = bookButton(library, String(book?.title));
    const image = button.locator("img");
    await expect(image).toBeVisible();
    const dimensions = await image.evaluate((img: HTMLImageElement) => [
      img.naturalWidth,
      img.naturalHeight,
    ]);
    expect(dimensions).toEqual(name.endsWith("epub") ? [24, 24] : [512, 512]);
  }
  // Extracted fields participate in real library search; both authors remain
  // ordered, and a duplicate subject has a single searchable display value.
  await library.getByRole("searchbox").fill("Ana Travel");
  await expect(library.locator(".result-count")).toHaveText("1 book");
  await expect(bookButton(library, "Garden Atlas")).toBeVisible();
  await library.getByRole("searchbox").fill("");
  const pdf = await openCatalogReader(application, "Garden Atlas");
  await expect(pdf.ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  const epub = await openCatalogReader(application, "Garden Stories");
  await expect(epub.ui.getByTestId("visible-text")).toContainText(
    "ORCHID EPUB FIRST",
  );
  const missing = await openCatalogReader(application, "import-no-metadata");
  await expect(missing.ui.getByTestId("visible-text")).toContainText(
    "ORCHID EPUB FIRST",
  );
  expect(await readdir(join(profile, "library/staging"))).toEqual([]);
  expect(
    catalog(profile, (db) =>
      db
        .prepare(
          "SELECT count(*) AS n FROM recovery_operations WHERE state NOT IN ('committed', 'abandoned')",
        )
        .get(),
    ),
  ).toEqual({ n: 0 });
  // Every parser window/process is disposed; only library and two readers.
  expect(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(4);
});

// Inject failure at the parser execution boundary, after a real isolated page
// loads. CPU hangs and memory pressure remain in that renderer; main and an
// already open reader must continue working and dispose the failed job.
for (const mode of ["cancel", "timeout", "memory", "cover-crash"] as const) {
  test(`disposes a parser on ${mode}, keeps other windows responsive and permits the next import`, async ({
    application,
    profile,
  }) => {
    test.setTimeout(45_000);
    const library = await application.firstWindow();
    await importFiles(application, library, [fixture("known.pdf")]);
    await expect(summary(library).getByTestId("import-counts")).toHaveText(
      "1 imported",
    );
    await library.getByRole("button", { name: "Dismiss" }).click();
    const reader = await openCatalogReader(application, "known");
    const readerPids = await application.evaluate(({ BrowserWindow }) => {
      const reader = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "known — reader shell",
      );
      return (
        reader?.webContents.mainFrame.framesInSubtree.map(
          (frame) => frame.osProcessId,
        ) ?? []
      );
    });
    expect(readerPids.length).toBeGreaterThan(1);
    await application.evaluate(({ app }, mode) => {
      const state = globalThis as { parserPid?: number; parserGone?: boolean };
      app.once("browser-window-created", (_, window) => {
        const contents = window.webContents;
        const original = contents.executeJavaScript.bind(contents);
        contents.executeJavaScript = (code, gesture) => {
          if (code.startsWith("globalThis.inspectBook")) {
            state.parserPid = contents.getOSProcessId();
            window.once("closed", () => {
              state.parserGone = true;
            });
            if (mode !== "cover-crash")
              return original(
                mode === "memory"
                  ? "globalThis.pressure = new Uint8Array(600 * 1024 * 1024); globalThis.pressure.fill(1); new Promise(() => {})"
                  : "(() => { while (true) {} })()",
                gesture,
              );
          }
          if (mode === "cover-crash" && code === "globalThis.extractCover()")
            contents.forcefullyCrashRenderer();
          return original(code, gesture);
        };
      });
    }, mode);
    await importFiles(application, library, [fixture("import-metadata.pdf")]);
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as { parserPid?: number }).parserPid,
        ),
      )
      .toBeGreaterThan(0);
    const parserPid = await application.evaluate(
      () => (globalThis as { parserPid?: number }).parserPid,
    );
    expect(readerPids).not.toContain(parserPid);
    // Main-backed query plus real reader input while the parser is wedged.
    expect(
      await value<{ title: string }[]>(library, "books", {
        view: { kind: "all" },
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "known" })]),
    );
    await reader.ui.getByRole("button", { name: "Next", exact: true }).click();
    await expect(reader.ui.getByTestId("page-text")).toContainText(
      "CEDAR SECOND",
    );
    if (mode === "cancel")
      await library.getByRole("button", { name: "Cancel import" }).click();
    await expect(summary(library)).toBeVisible({ timeout: 35_000 });
    await expect(summary(library)).toContainText(
      mode === "cancel"
        ? "1 cancelled"
        : mode === "timeout"
          ? "30 second time limit"
          : mode === "memory"
            ? "512 MiB working memory limit"
            : "Warning: Cover extraction stopped; a placeholder was used.",
    );
    expect(
      await application.evaluate(
        () => (globalThis as { parserGone?: boolean }).parserGone,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        application.evaluate(
          ({ app }, pid) =>
            app.getAppMetrics().some((process) => process.pid === pid),
          parserPid,
        ),
      )
      .toBe(false);
    expect(await readdir(join(profile, "library/staging"))).toEqual([]);
    if (mode !== "cover-crash") {
      expect(
        catalog(profile, (db) =>
          db.prepare("SELECT count(*) AS n FROM books").get(),
        ),
      ).toEqual({ n: 1 });
      await library.getByRole("button", { name: "Dismiss" }).click();
      await importFiles(application, library, [
        fixture("import-metadata.epub"),
      ]);
      await expect(summary(library).getByTestId("import-counts")).toHaveText(
        "1 imported",
      );
      await expect(
        bookButton(library, "Garden Stories").locator("img"),
      ).toBeVisible();
    }
    expect(
      await application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(2);
  });
}

test("the importer has no host bridge, cannot fetch outside its assigned assets, and never executes book markup", async ({
  application,
  profile,
}) => {
  const library = await application.firstWindow();
  await application.evaluate(({ app }) => {
    app.once("browser-window-created", (_, window) => {
      const contents = window.webContents;
      const original = contents.executeJavaScript.bind(contents);
      contents.executeJavaScript = async (code, gesture) => {
        if (!code.startsWith("globalThis.inspectBook"))
          return original(code, gesture);
        const probe = await original(
          `(async () => {
          const result = await ${code};
          const urls = ['https://borges.invalid/probe', 'file:///etc/passwd', 'borges://app/index.html', 'borges://extract/index.html', 'borges://extract/reader-assets/%2e%2e/%2e%2e/index.html'];
          const denied = await Promise.all(urls.map(async url => {try {return !(await fetch(url)).ok;} catch {return true;}}));
          return {result, denied, bridge: typeof globalThis.borges, node: typeof globalThis.process, require: typeof globalThis.require, script: globalThis.bookScriptRan === true, popup: window.open('borges://app/index.html') === null};
        })()`,
          gesture,
        );
        (globalThis as { importProbe?: unknown }).importProbe = probe;
        return probe.result;
      };
    });
  });
  await importFiles(application, library, [fixture("malicious.epub")]);
  await expect(summary(library).getByTestId("import-counts")).toHaveText(
    "1 imported",
  );
  expect(
    await application.evaluate(
      () => (globalThis as { importProbe?: unknown }).importProbe,
    ),
  ).toMatchObject({
    denied: [true, true, true, true, true],
    bridge: "undefined",
    node: "undefined",
    require: "undefined",
    script: false,
    popup: true,
  });
  expect(
    await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  expect(await readdir(join(profile, "library/staging"))).toEqual([]);
});
