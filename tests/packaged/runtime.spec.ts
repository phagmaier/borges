import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";
import { addFileAsNewBook } from "../../src/library/import";
import type { BookSummary } from "../../src/library/query";
import type { TrashListing } from "../../src/library/trash";
import { openLibrary } from "../../src/storage/catalog";
import { catalogMigrations } from "../../src/storage/schema";
import { bookButton, openCatalogReader, value } from "../e2e/catalog";

let root: string;
let executablePath: string;
let profile: string;
let cwd: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "borges-packaged-"));
  // Relocate the complete artifact outside the checkout. Runtime has no package
  // manager, source directory, node_modules, or development server to lean on.
  await cp(resolve("dist/borges-runtime-check"), join(root, "relocated"), {
    recursive: true,
  });
  executablePath = join(root, "relocated/borges");
  cwd = join(root, "empty-working-directory");
  await mkdir(cwd);
});
test.beforeEach(async () => {
  profile = await mkdtemp(join(root, "profile-"));
});
test.afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** The packaged default root under this test's isolated XDG data home. */
const libraryFor = (home: string) => join(home, "data/borges/library");

function environment(home = profile, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PATH: "/usr/bin:/bin",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    ELECTRON_RUN_AS_NODE: "",
    // A packaged app must use its local bundle even with a stray dev setting.
    ELECTRON_RENDERER_URL: "http://127.0.0.1:1",
    BORGES_DEV_PROFILE: home,
    // Never fall through to the user's real ~/.local/share library.
    XDG_DATA_HOME: join(home, "data"),
    BORGES_LIBRARY_ROOT: "",
    ...extra,
  };
}

async function launch(home = profile, extra: Record<string, string> = {}) {
  return electron.launch({
    executablePath,
    args: [],
    cwd,
    env: environment(home, extra),
  });
}

async function catalogOf(application: ElectronApplication) {
  const library = await application.firstWindow();
  await expect(library.getByTestId("library-id")).toHaveText(/^[0-9a-f-]{36}$/);
  return {
    library,
    info: await library.evaluate(() => window.development.getRuntimeInfo()),
  };
}

/** Refusals stay visible until closed, then exit unsuccessfully. */
async function refusedLaunch(env: Record<string, string>, reactivate = false) {
  const application = await electron.launch({
    executablePath,
    args: [],
    cwd,
    env,
  });
  const child = application.process();
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Borges cannot open its library" }),
    ).toBeVisible();
    const explanation = await page.locator("main").textContent();
    await expect(page.locator("main img, main script")).toHaveCount(0);
    expect(child.exitCode).toBeNull();
    expect(
      await page.evaluate(() => ({
        bridge: typeof Reflect.get(window, "borges"),
        development: typeof Reflect.get(window, "development"),
        require: typeof Reflect.get(window, "require"),
      })),
    ).toEqual({
      bridge: "undefined",
      development: "undefined",
      require: "undefined",
    });
    expect(
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error("Missing startup window");
        const preferences =
          // Electron exposes this at runtime but omits it from its public types.
          (
            window.webContents as unknown as {
              getLastWebPreferences(): Record<string, unknown>;
            }
          ).getLastWebPreferences();
        return {
          sandbox: preferences?.sandbox,
          contextIsolation: preferences?.contextIsolation,
          javascript: preferences?.javascript,
        };
      }),
    ).toEqual({ sandbox: true, contextIsolation: true, javascript: false });
    if (reactivate) {
      await application.evaluate(({ app }) => {
        Reflect.set(globalThis, "secondLaunch", false);
        app.once("second-instance", () =>
          Reflect.set(globalThis, "secondLaunch", true),
        );
      });
      const second = spawn(executablePath, [], { cwd, env, stdio: "ignore" });
      try {
        await expect.poll(() => second.exitCode).toBe(0);
        await expect
          .poll(() =>
            application.evaluate(() => Reflect.get(globalThis, "secondLaunch")),
          )
          .toBe(true);
        expect(application.windows()).toHaveLength(1);
        await expect(
          page.getByRole("heading", { name: "Borges cannot open its library" }),
        ).toBeVisible();
      } finally {
        if (second.exitCode === null) second.kill();
      }
    }
    await page.screenshot({ path: "test-results/startup-refusal.png" });
    await page.close();
    await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(1);
    return explanation;
  } finally {
    if (child.exitCode === null) await application.close();
  }
}

test("relocated runtime keeps one catalog across restarts and a moved root", async () => {
  let application: ElectronApplication | undefined;
  const libraryRoot = libraryFor(profile);
  try {
    application = await launch();
    const { library, info } = await catalogOf(application);
    expect(library.url()).toBe("borges://app/index.html");
    expect(
      await application.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath(),
        executable: process.execPath,
      })),
    ).toEqual({
      packaged: true,
      path: join(root, "relocated/resources/app"),
      executable: executablePath,
    });
    expect(info).toMatchObject({
      electron: "45.2.1",
      node: "24.22.1",
      sqlite: "3.53.4",
      sandboxed: true,
      contextIsolated: true,
      catalog: {
        schemaVersion: 3,
        root: libraryRoot,
        created: true,
        upgradedFrom: null,
        recoveredStaleLockPid: null,
      },
    });
    const { libraryId } = info.catalog;
    // Exercise the copied workers/engines/assets, not only the shell bundle.
    for (const bookId of ["sample-pdf", "sample-epub"]) {
      const [reader] = await Promise.all([
        application.waitForEvent("window"),
        library.evaluate((id) => window.development.openReader(id), bookId),
      ]);
      const content = reader.frameLocator('iframe[title="Book content"]');
      await expect(content.getByRole("status")).toHaveText("Ready");
      if (bookId === "sample-pdf") {
        await expect(content.getByTestId("page-text")).toContainText(
          "ORCHID FIRST",
        );
      } else {
        const chapter = reader
          .frames()
          .find((frame) => frame.url().startsWith("blob:borges://reader-"));
        if (!chapter) throw new Error("Missing packaged EPUB chapter");
        await expect(chapter.locator("body")).toContainText(
          "ORCHID EPUB FIRST",
        );
        expect(
          await chapter
            .getByAltText("Coral square")
            .evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth === 24,
            ),
        ).toBe(true);
      }
    }
    await application.close();
    application = undefined;

    // Independent input written while closed must survive the next startup.
    const database = new DatabaseSync(join(libraryRoot, "catalog.sqlite"));
    try {
      expect(
        database.prepare("SELECT library_id FROM library").get()?.library_id,
      ).toBe(libraryId);
      database
        .prepare(
          "INSERT INTO sections (id, name, name_key, created_at) VALUES ('s1', ?, 'marker', 1)",
        )
        .run("Persisted across restart — 蘭");
    } finally {
      database.close();
    }

    application = await launch();
    expect((await catalogOf(application)).info.catalog).toMatchObject({
      libraryId,
      created: false,
    });
    await application.close();
    application = undefined;
    const reopened = new DatabaseSync(join(libraryRoot, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      expect(reopened.prepare("SELECT name FROM sections").all()).toEqual([
        { name: "Persisted across restart — 蘭" },
      ]);
    } finally {
      reopened.close();
    }

    // A closed library copied elsewhere works through explicit configuration
    // without the original path.
    const moved = join(profile, "moved/library");
    await cp(libraryRoot, moved, { recursive: true });
    await rename(libraryRoot, `${libraryRoot}-original`);
    application = await launch(profile, { BORGES_LIBRARY_ROOT: moved });
    expect((await catalogOf(application)).info.catalog).toMatchObject({
      libraryId,
      root: moved,
      created: false,
    });
  } finally {
    await application?.close();
  }
});

test("another profile cannot share a locked root; a killed holder is recovered", async () => {
  const other = await mkdtemp(join(root, "other-profile-"));
  // Both profiles point at the first profile's library root. Different
  // profiles bypass Electron's single-instance routing, as another build would.
  const shared = { XDG_DATA_HOME: join(profile, "data") };
  let holder: ElectronApplication | undefined = await launch();
  let successor: ElectronApplication | undefined;
  try {
    const { library, info } = await catalogOf(holder);
    const pid = holder.process().pid;
    const explanation = await refusedLaunch(environment(other, shared), true);
    expect(explanation).toContain(
      `The library at ${libraryFor(profile)} is in use by another Borges process (process ${pid} `,
    );
    // The holder is unaffected and still answers through its catalog.
    expect(
      (await library.evaluate(() => window.development.getRuntimeInfo()))
        .catalog.libraryId,
    ).toBe(info.catalog.libraryId);

    const exited = new Promise((done) => holder?.process().once("exit", done));
    holder.process().kill("SIGKILL");
    await exited;
    holder = undefined;
    successor = await launch(other, shared);
    expect((await catalogOf(successor)).info.catalog).toMatchObject({
      libraryId: info.catalog.libraryId,
      created: false,
      recoveredStaleLockPid: pid,
    });
  } finally {
    await holder?.close();
    await successor?.close();
  }
});

for (const scenario of [
  {
    name: "newer schema",
    prepare: (database: DatabaseSync) =>
      database.exec(
        "PRAGMA user_version = 4; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep this');",
      ),
    error: "uses schema 4, but this Borges build supports schema 3 at most",
  },
  {
    name: "damaged supported schema",
    prepare: (database: DatabaseSync) =>
      database.exec("DROP TABLE trash_entries"),
    catalog: true,
    error: "does not match schema 3",
  },
  {
    name: "foreign database",
    prepare: (database: DatabaseSync) =>
      database.exec(
        "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep this too');",
      ),
    error: "is a populated SQLite database without a Borges schema",
  },
  {
    name: "unreadable catalog",
    prepare: (_database: DatabaseSync) => {},
    bytes: "This is not a SQLite database",
    error: "cannot be read",
  },
  {
    name: "failed upgrade",
    catalog: true,
    from: 2,
    prepare: (_database: DatabaseSync) => {},
    readOnly: true,
    error: "Upgrading the catalog from schema 2 to 3 failed",
  },
]) {
  test(`packaged startup refuses ${scenario.name} and retains the catalog`, async () => {
    const libraryRoot = join(
      libraryFor(profile),
      "Library <img src=x onerror=alert(1)>",
    );
    await mkdir(libraryRoot, { recursive: true });
    if (scenario.catalog)
      openLibrary({
        root: libraryRoot,
        migrations: catalogMigrations.slice(0, scenario.from ?? 3),
      }).close();
    const path = join(libraryRoot, "catalog.sqlite");
    const database = new DatabaseSync(path);
    scenario.prepare(database);
    database.close();
    if (scenario.bytes) await writeFile(path, scenario.bytes);
    if (scenario.readOnly) await chmod(path, 0o444);
    const before = await readFile(path);
    const explanation = await refusedLaunch(
      environment(profile, { BORGES_LIBRARY_ROOT: libraryRoot }),
    );
    expect(explanation).toContain("Borges cannot open its library");
    expect(explanation).toContain(scenario.error);
    expect(explanation).toContain(libraryRoot);
    expect(explanation).toContain(
      scenario.readOnly ? "It remains at schema 2" : "It was not changed",
    );
    expect(await readFile(path)).toEqual(before);
  });
}

for (const from of [1, 2]) {
  test(`packaged startup upgrades a schema-${from} catalog after a verified snapshot`, async () => {
    const libraryRoot = libraryFor(profile);
    const old = openLibrary({
      root: libraryRoot,
      migrations: catalogMigrations.slice(0, from),
    });
    const { libraryId } = old;
    old.close();
    const application = await launch();
    try {
      expect((await catalogOf(application)).info.catalog).toMatchObject({
        libraryId,
        schemaVersion: 3,
        created: false,
        upgradedFrom: from,
      });
    } finally {
      await application.close();
    }
    const snapshots = await readdir(join(libraryRoot, "recovery"));
    expect(snapshots).toEqual([
      expect.stringMatching(
        new RegExp(`^catalog-schema-${from}-before-3-.*\\.sqlite$`),
      ),
    ]);
    const snapshot = new DatabaseSync(
      join(libraryRoot, "recovery", snapshots[0] ?? ""),
      {
        readOnly: true,
      },
    );
    try {
      expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(
        from,
      );
    } finally {
      snapshot.close();
    }
  });
}

test("packaged readers save/resume, replace across formats and retain the old position", async () => {
  const sources = await mkdtemp(join(root, "sources-"));
  const source = join(sources, "Known PDF.pdf");
  await cp(resolve("tests/fixtures/known.pdf"), source);
  const seeded = openLibrary({ root: libraryFor(profile) });
  const { bookId } = await addFileAsNewBook(seeded, source);
  seeded.close();
  const page = () => {
    const database = new DatabaseSync(
      join(libraryFor(profile), "catalog.sqlite"),
      { readOnly: true },
    );
    try {
      return database
        .prepare(
          "SELECT p.pdf_page AS page FROM books b JOIN positions p ON p.revision_id = b.current_revision_id WHERE b.id = ?",
        )
        .get(bookId)?.page;
    } finally {
      database.close();
    }
  };
  async function read(application: ElectronApplication) {
    const library = await application.firstWindow();
    const opened = application.waitForEvent("window");
    await library
      .getByRole("list", { name: "Books" })
      .getByRole("button", { name: "Known PDF", exact: true })
      .click();
    const reader = await opened;
    const ui = reader.frameLocator('iframe[title="Book content"]');
    await expect(ui.getByRole("status")).toHaveText("Ready");
    return { reader, ui };
  }

  // The development-only interval override is ignored by packaged builds.
  let application = await launch(profile, {
    BORGES_SAVE_INTERVAL_MS: "600000",
  });
  try {
    const { ui } = await read(application);
    await expect(ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
    const surface = ui.getByRole("region", { name: "Reading surface" });
    await surface.focus();
    await surface.press("ArrowRight");
    await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
    await expect.poll(page, { timeout: 2000 }).toBe(2);
    // Quit must await a page turn still rendering in the relocated engine.
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
    });
  } finally {
    await application.close();
  }
  application = await launch(profile);
  try {
    const { ui } = await read(application);
    await expect(ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
    await ui.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
    const library = await application.firstWindow();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, resolve("tests/fixtures/import-metadata.epub"));
    const result = await library.evaluate(
      (id) => window.borges.library.replaceFile(id),
      bookId,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        book: { id: bookId, title: "Garden Stories", format: "epub" },
        warnings: [],
      },
    });
    await expect(ui.getByTestId("visible-text")).toContainText(
      "ORCHID EPUB FIRST",
    );
    const database = new DatabaseSync(
      join(libraryFor(profile), "catalog.sqlite"),
      { readOnly: true },
    );
    try {
      expect(
        database
          .prepare(
            `SELECT p.pdf_page FROM trash_entries t JOIN positions p ON p.revision_id = t.revision_id WHERE t.book_id = ?`,
          )
          .get(bookId),
      ).toEqual({ pdf_page: 2 });
    } finally {
      database.close();
    }
  } finally {
    await application.close();
  }
  application = await launch(profile);
  try {
    const library = await application.firstWindow();
    const opened = application.waitForEvent("window");
    await library
      .getByRole("button", { name: "Garden Stories", exact: true })
      .click();
    const reader = await opened;
    await expect(
      reader
        .frameLocator('iframe[title="Book content"]')
        .getByTestId("visible-text"),
    ).toContainText("ORCHID EPUB FIRST");
  } finally {
    await application.close();
  }
  // The source file was only read.
  expect(await readFile(source)).toEqual(
    await readFile(resolve("tests/fixtures/known.pdf")),
  );
});

test("imports and extracts offline from the relocated bundle and retains extracted/manual provenance after restart", async () => {
  let application: ElectronApplication | undefined;
  const paths = [
    "import-metadata.pdf",
    "import-metadata.epub",
    "import-no-metadata.epub",
    "import-password.pdf",
  ].map((name) => resolve("tests/fixtures", name));
  try {
    application = await launch();
    let { library } = await catalogOf(application);
    await application.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: paths,
      })) as typeof dialog.showOpenDialog;
    }, paths);
    await library.getByRole("button", { name: "Import files…" }).click();
    await expect(library.getByTestId("import-counts")).toHaveText(
      "1 unsupported · 3 imported",
    );
    const books = await library.evaluate(async () => {
      const result = await window.borges.library.books({
        view: { kind: "all" },
      });
      if (!result.ok) throw new Error(result.message);
      return result.value;
    });
    const atlas = books.find((b) => b.title === "Garden Atlas");
    expect(atlas?.authors).toEqual(["Zora", "Ana"]);
    expect(atlas?.coverToken).toMatch(/^[0-9a-f]{64}$/);
    const id = String(atlas?.id);
    await library.evaluate(async (id) => {
      const result = await window.borges.library.editMetadata(id, {
        title: "Manual atlas",
        authors: [],
      });
      if (!result.ok) throw new Error(result.message);
    }, id);
    await application.close();
    application = await launch();
    ({ library } = await catalogOf(application));
    const card = library.getByRole("button", {
      name: "Manual atlas",
      exact: true,
    });
    await expect(card.locator("img")).toBeVisible();
    const db = new DatabaseSync(join(libraryFor(profile), "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      expect({
        ...db
          .prepare(
            "SELECT b.title, b.title_manual, b.authors_manual, b.cover_manual, r.extracted_title, r.extracted_authors, r.extracted_cover_path FROM books b JOIN revisions r ON r.id = b.current_revision_id WHERE b.id = ?",
          )
          .get(id),
      }).toMatchObject({
        title: "Manual atlas",
        title_manual: 1,
        authors_manual: 1,
        cover_manual: 0,
        extracted_title: "Garden Atlas",
        extracted_authors: '["Zora","Ana"]',
        extracted_cover_path: expect.stringMatching(/^covers\//),
      });
    } finally {
      db.close();
    }
    const opened = application.waitForEvent("window");
    await library
      .getByRole("button", { name: "import-no-metadata", exact: true })
      .click();
    const reader = await opened;
    await expect(
      reader
        .frameLocator('iframe[title="Book content"]')
        .getByTestId("visible-text"),
    ).toContainText("ORCHID EPUB FIRST");
  } finally {
    await application?.close();
  }
});

test("relocated Trash deletion and restore survive separate process restarts with the saved reader position", async () => {
  const seeded = openLibrary({ root: libraryFor(profile) });
  await addFileAsNewBook(seeded, resolve("tests/fixtures/known.pdf"));
  seeded.close();
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    let { library } = await catalogOf(application);
    let opened = application.waitForEvent("window");
    await library
      .getByRole("list", { name: "Books" })
      .getByRole("button", { name: "known", exact: true })
      .click();
    let reader = await opened;
    let ui = reader.frameLocator('iframe[title="Book content"]');
    await expect(ui.getByRole("status")).toHaveText("Ready");
    const surface = ui.getByRole("region", { name: "Reading surface" });
    await surface.focus();
    await surface.press("ArrowRight");
    await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
    await library.getByRole("checkbox", { name: "Select known" }).check();
    await library
      .getByRole("button", { name: "Move to Trash…", exact: true })
      .click();
    await library
      .getByRole("dialog")
      .getByRole("button", { name: "Move to Trash", exact: true })
      .click();
    await expect(library.getByRole("status")).toContainText(
      "Moved 1 book to Trash",
    );
    expect(application.windows()).toHaveLength(1);
    await application.close();
    application = await launch();
    ({ library } = await catalogOf(application));
    await expect(library.locator(".result-count")).toHaveText("0 books");
    await library
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: "Trash", exact: true })
      .click();
    const trash = library.getByRole("region", { name: "Trash contents" });
    await expect(trash).toContainText("Page 2");
    await trash.getByRole("button", { name: "Restore book" }).click();
    await expect(trash.getByRole("status")).toContainText("Restored “known”");
    await application.close();
    application = await launch();
    ({ library } = await catalogOf(application));
    opened = application.waitForEvent("window");
    await library
      .getByRole("list", { name: "Books" })
      .getByRole("button", { name: "known", exact: true })
      .click();
    reader = await opened;
    ui = reader.frameLocator('iframe[title="Book content"]');
    await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
  } finally {
    await application?.close();
  }
});

test("relocated Trash-only import restores an earlier revision and its position across process restarts", async () => {
  const seeded = openLibrary({ root: libraryFor(profile) });
  const { bookId } = await addFileAsNewBook(
    seeded,
    resolve("tests/fixtures/known.pdf"),
  );
  seeded.close();
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    let { library } = await catalogOf(application);
    await library.evaluate(async (id) => {
      const result = await window.borges.library.editMetadata(id, {
        title: "Personal Atlas",
      });
      if (!result.ok) throw new Error(result.message);
    }, bookId);
    const opened = application.waitForEvent("window");
    await library
      .getByRole("list", { name: "Books" })
      .getByRole("button", { name: "Personal Atlas", exact: true })
      .click();
    const reader = await opened;
    const ui = reader.frameLocator('iframe[title="Book content"]');
    await expect(ui.getByRole("status")).toHaveText("Ready");
    const surface = ui.getByRole("region", { name: "Reading surface" });
    await surface.focus();
    await surface.press("ArrowRight");
    await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, resolve("tests/fixtures/import-metadata.epub"));
    await library.evaluate(async (id) => {
      const result = await window.borges.library.replaceFile(id);
      if (!result.ok) throw new Error(result.message);
    }, bookId);
    await application.close();
    application = await launch();
    ({ library } = await catalogOf(application));
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, resolve("tests/fixtures/known.pdf"));
    await library
      .getByRole("button", { name: "Import files…", exact: true })
      .click();
    const match = library.getByRole("dialog", {
      name: "Identical content in Trash",
    });
    await match.getByRole("radio").check();
    await match
      .getByRole("button", { name: "Restore as current", exact: true })
      .click();
    await expect(library.getByTestId("import-counts")).toHaveText(
      "1 restored/reused",
    );
    await application.close();
    application = await launch();
    ({ library } = await catalogOf(application));
    const resumed = application.waitForEvent("window");
    await library
      .getByRole("list", { name: "Books" })
      .getByRole("button", { name: "Personal Atlas", exact: true })
      .click();
    await expect(
      (await resumed)
        .frameLocator('iframe[title="Book content"]')
        .locator("#location"),
    ).toHaveText("Page 2 of 3");
  } finally {
    await application?.close();
  }
});

test("relocated Empty Trash reconciles a failed final commit and preserves live files and sources across restart", async () => {
  const rootPath = libraryFor(profile);
  const seeded = openLibrary({ root: rootPath });
  const source = resolve("tests/fixtures/known.pdf");
  const before = await readFile(source);
  const trashed = await addFileAsNewBook(seeded, source);
  const live = await addFileAsNewBook(
    seeded,
    resolve("tests/fixtures/image-only.pdf"),
  );
  seeded.close();
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    let { library } = await catalogOf(application);
    await library.evaluate(async (id) => {
      const result = await window.borges.library.deleteBook(id);
      if (!result.ok) throw new Error(result.message);
    }, trashed.bookId);
    const db = new DatabaseSync(join(rootPath, "catalog.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER refuse_purge BEFORE DELETE ON trash_entries BEGIN SELECT RAISE(ABORT, 'purge commit failed'); END",
      );
      const result = await library.evaluate(async () => {
        const snapshot = await window.borges.library.trash();
        if (!snapshot.ok) throw new Error(snapshot.message);
        return window.borges.library.emptyTrash(
          snapshot.value.entries.map((e) => e.id),
          snapshot.value.bytes,
        );
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          purged: 0,
          failures: [
            { message: expect.stringContaining("purge commit failed") },
          ],
        },
      });
      expect(await readdir(join(rootPath, "files"))).toEqual([
        live.path.slice(6),
      ]);
      db.exec("DROP TRIGGER refuse_purge");
    } finally {
      db.close();
    }
    await application.close();
    application = await launch();
    ({ library } = await catalogOf(application));
    await library
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: "Trash", exact: true })
      .click();
    await expect(
      library.getByText("Trash is empty.", { exact: true }),
    ).toBeVisible();
    expect(await readdir(join(rootPath, "files"))).toEqual([
      live.path.slice(6),
    ]);
    expect(await readFile(source)).toEqual(before);
    const verified = new DatabaseSync(join(rootPath, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(verified.prepare("SELECT id FROM books").all()).toEqual([
        { id: live.bookId },
      ]);
    } finally {
      verified.close();
    }
  } finally {
    await application?.close();
  }
});

test("A12: a populated closed-folder backup restores readers, covers, Archive and Trash independently", async () => {
  test.setTimeout(60_000);
  const original = libraryFor(profile);
  const backup = join(root, "Populated backup — 蘭");
  const hidden = `${original}-unavailable`;
  const sources = join(profile, "sources");
  await mkdir(sources);
  const names = ["known.pdf", "image-only.pdf", "import-metadata.epub"];
  for (const name of names.slice(0, 2))
    await cp(resolve("tests/fixtures", name), join(sources, name));
  const coverSource = join(sources, "manual.png");
  let application: ElectronApplication | undefined;
  async function choose(path: string) {
    if (!application) throw new Error("Application is closed");
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, path);
  }
  try {
    application = await launch();
    let { library, info } = await catalogOf(application);
    const { libraryId } = info.catalog;
    await choose(sources);
    await library.getByRole("button", { name: "Import folder…" }).click();
    await expect(library.getByTestId("import-counts")).toHaveText("2 imported");
    const books = await value<BookSummary[]>(library, "books");
    const atlas = books.find((book) => book.title === "known");
    const scan = books.find((book) => book.title === "image-only");
    if (!atlas || !scan) throw new Error("Missing imported books");
    await cp(
      resolve("tests/fixtures/import-metadata.epub"),
      join(sources, "import-metadata.epub"),
    );
    const shelf = await value<{ id: string }>(
      library,
      "createSection",
      "Shelf",
      null,
    );
    const section = await value<{ id: string }>(
      library,
      "createSection",
      "Maps",
      shelf.id,
    );
    await value(library, "addToSection", section.id, [atlas.id, scan.id]);
    const metadata = {
      title: "Personal atlas — 蘭",
      authors: ["Mira"],
      subjects: ["Private maps"],
    };
    await value(library, "editMetadata", atlas.id, metadata);
    const coverBytes = await application.evaluate(({ nativeImage }) =>
      Array.from(
        nativeImage
          .createFromBitmap(Buffer.from([80, 100, 240, 255]), {
            width: 1,
            height: 1,
          })
          .toPNG(),
      ),
    );
    await writeFile(coverSource, Buffer.from(coverBytes));
    await choose(coverSource);
    const covered = await value<BookSummary>(library, "chooseCover", atlas.id);
    expect(covered.coverToken).toMatch(/^[0-9a-f]{64}$/);
    const { reader, ui } = await openCatalogReader(application, metadata.title);
    const surface = ui.getByRole("region", { name: "Reading surface" });
    await surface.focus();
    await surface.press("ArrowRight");
    await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
    await value(library, "finish", atlas.id);
    await value(library, "archive", atlas.id);
    await choose(join(sources, "import-metadata.epub"));
    await value(library, "replaceFile", atlas.id);
    await expect(ui.getByRole("status")).toHaveText("Ready");
    await expect(ui.getByTestId("visible-text")).toContainText(
      "ORCHID EPUB FIRST",
    );
    await ui.getByRole("button", { name: "Search", exact: true }).click();
    const search = ui.getByRole("searchbox");
    await search.fill("LANTERN PASSAGE 24.");
    await expect(ui.locator("#search-status")).toHaveText("1 matches");
    await search.press("Enter");
    await search.press("Escape");
    await ui.getByRole("spinbutton", { name: "Font size" }).fill("22");
    await ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
    await expect(ui.getByTestId("visible-text")).toContainText(
      "LANTERN PASSAGE 24.",
    );
    // Repagination reports its completed location asynchronously. Establish
    // the saved input before testing the backup's ability to recover it.
    await expect
      .poll(() => {
        const database = new DatabaseSync(join(original, "catalog.sqlite"), {
          readOnly: true,
        });
        try {
          return database
            .prepare("SELECT font_size FROM reader_settings WHERE book_id = ?")
            .get(atlas.id)?.font_size;
        } finally {
          database.close();
        }
      })
      .toBe(22);
    await reader.close();
    await value(library, "deleteBook", scan.id);
    const retained = await value<TrashListing>(library, "trash");
    expect(retained.entries).toHaveLength(2);
    expect(
      retained.entries.find((entry) => entry.kind === "revision"),
    ).toMatchObject({ position: "Page 2" });
    await application.close();
    application = undefined;

    // Copy the entire closed folder. Neither the old root, source files nor
    // the original profile's caches are available at their recorded paths.
    await cp(original, backup, { recursive: true });
    await rename(original, hidden);
    await rename(sources, `${sources}-unavailable`);
    const originalDatabase = await readFile(join(hidden, "catalog.sqlite"));
    const originalFiles = await readdir(join(hidden, "files"));
    const originalCovers = await readdir(join(hidden, "covers"));
    const copyProfile = await mkdtemp(join(root, "backup-profile-"));
    application = await launch(copyProfile, { BORGES_LIBRARY_ROOT: backup });
    ({ library, info } = await catalogOf(application));
    expect(info.catalog).toMatchObject({
      libraryId,
      root: backup,
      created: false,
    });
    expect(await value(library, "startupProblems")).toEqual([]);
    expect(await value(library, "books")).toEqual([]); // Archive/Trash stay scoped.
    expect(
      await value(library, "books", { view: { kind: "archive" } }),
    ).toMatchObject([
      {
        id: atlas.id,
        ...metadata,
        status: "finished",
        archived: true,
        sectionIds: [section.id],
        coverToken: covered.coverToken,
        format: "epub",
      },
    ]);
    expect(
      await value(library, "sections", { includeArchived: true }),
    ).toMatchObject([
      { id: shelf.id, children: [{ id: section.id, bookCount: 1 }] },
    ]);
    expect(await value(library, "trash")).toEqual(retained);
    await library
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    const image = bookButton(library, metadata.title).locator("img");
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    const resumed = await openCatalogReader(application, metadata.title);
    await expect(resumed.ui.getByTestId("visible-text")).toContainText(
      "LANTERN PASSAGE 24.",
    );
    await expect(resumed.reader.getByTestId("restoration-notice")).toHaveCount(
      0,
    );
    await expect(
      resumed.ui.getByRole("spinbutton", { name: "Font size" }),
    ).toHaveValue("22");
    await resumed.reader.close();

    // Switch back to retained bytes and their saved page in the copied root.
    const old = retained.entries.find((entry) => entry.kind === "revision");
    const deleted = retained.entries.find((entry) => entry.kind === "book");
    if (!old || !deleted) throw new Error("Missing retained context");
    await value(
      library,
      "restoreRevision",
      old.id,
      "current",
      old.currentRevisionId,
    );
    const restored = await openCatalogReader(application, metadata.title);
    await expect(restored.ui.getByTestId("page-text")).toContainText(
      "CEDAR SECOND",
    );
    await expect(restored.ui.locator("#location")).toHaveText("Page 2 of 3");
    await value(library, "restoreDeletedBook", deleted.id);
    expect(await value(library, "books")).toMatchObject([
      { id: scan.id, sectionIds: [section.id], status: "unread" },
    ]);
    const purge = await value<TrashListing>(library, "trash");
    expect(purge.entries).toHaveLength(1); // Displaced EPUB only.
    expect(
      await value(
        library,
        "emptyTrash",
        purge.entries.map((entry) => entry.id),
        purge.bytes,
      ),
    ).toMatchObject({ purged: 1, failures: [] });
    await expect(restored.ui.getByTestId("page-text")).toContainText(
      "CEDAR SECOND",
    );
    await expect(image).toBeVisible(); // Purge preserves the manual cover.
    await application.close();
    application = undefined;

    application = await launch(copyProfile, { BORGES_LIBRARY_ROOT: backup });
    ({ library } = await catalogOf(application));
    expect(await value(library, "startupProblems")).toEqual([]);
    expect((await value<TrashListing>(library, "trash")).entries).toEqual([]);
    expect(
      await value(library, "books", { view: { kind: "archive" } }),
    ).toMatchObject([
      {
        id: atlas.id,
        ...metadata,
        archived: true,
        status: "finished",
        format: "pdf",
        sectionIds: [section.id],
        coverToken: covered.coverToken,
      },
    ]);
    await library
      .getByRole("navigation", { name: "Library" })
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    const copiedReader = await openCatalogReader(application, metadata.title);
    await expect(copiedReader.ui.locator("#location")).toHaveText(
      "Page 2 of 3",
    );
    await application.close();
    application = undefined;

    expect(await readFile(join(hidden, "catalog.sqlite"))).toEqual(
      originalDatabase,
    );
    expect(await readdir(join(hidden, "files"))).toEqual(originalFiles);
    expect(await readdir(join(hidden, "covers"))).toEqual(originalCovers);
    for (const name of names)
      expect(await readFile(join(`${sources}-unavailable`, name))).toEqual(
        await readFile(resolve("tests/fixtures", name)),
      );
    expect(
      await readFile(join(`${sources}-unavailable`, "manual.png")),
    ).toEqual(Buffer.from(coverBytes));
    // The original still has its EPUB/Archive state and both retained entries.
    application = await launch(profile, { BORGES_LIBRARY_ROOT: hidden });
    ({ library } = await catalogOf(application));
    expect(await value(library, "startupProblems")).toEqual([]);
    expect(await value(library, "trash")).toEqual(retained);
    expect(
      await value(library, "books", { view: { kind: "archive" } }),
    ).toMatchObject([
      {
        id: atlas.id,
        title: metadata.title,
        format: "epub",
        coverToken: covered.coverToken,
      },
    ]);
  } finally {
    await application?.close();
  }
});
