import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
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
import { openLibrary } from "../../src/storage/catalog";
import { catalogMigrations } from "../../src/storage/schema";

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

/** Run the packaged executable to completion, capturing its explanation. */
async function refusedLaunch(env: NodeJS.ProcessEnv) {
  let stderr = "";
  const child = spawn(executablePath, [], {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(1);
    return stderr;
  } finally {
    if (child.exitCode === null) child.kill();
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
        schemaVersion: 2,
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
          .find((frame) => frame.url().startsWith("blob:borges://reader/"));
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
    const stderr = await refusedLaunch(environment(other, shared));
    expect(stderr).toContain(
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
        "PRAGMA user_version = 3; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep this');",
      ),
    error: "uses schema 3, but this Borges build supports schema 2 at most",
  },
  {
    name: "damaged supported schema",
    prepare: (database: DatabaseSync) =>
      database.exec("DROP TABLE trash_entries"),
    catalog: true,
    error: "does not match schema 2",
  },
  {
    name: "foreign database",
    prepare: (database: DatabaseSync) =>
      database.exec(
        "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep this too');",
      ),
    error: "is a populated SQLite database without a Borges schema",
  },
]) {
  test(`packaged startup refuses a ${scenario.name} and retains the catalog`, async () => {
    const libraryRoot = libraryFor(profile);
    await mkdir(libraryRoot, { recursive: true });
    if (scenario.catalog) openLibrary({ root: libraryRoot }).close();
    const path = join(libraryRoot, "catalog.sqlite");
    const database = new DatabaseSync(path);
    scenario.prepare(database);
    database.close();
    const before = await readFile(path);
    const stderr = await refusedLaunch(environment());
    expect(stderr).toContain("Borges cannot open its library");
    expect(stderr).toContain(scenario.error);
    expect(stderr).toContain("It was not changed");
    expect(await readFile(path)).toEqual(before);
  });
}

test("packaged startup upgrades a schema-1 catalog after a verified snapshot", async () => {
  const libraryRoot = libraryFor(profile);
  const old = openLibrary({
    root: libraryRoot,
    migrations: catalogMigrations.slice(0, 1),
  });
  const { libraryId } = old;
  old.close();
  const application = await launch();
  try {
    expect((await catalogOf(application)).info.catalog).toMatchObject({
      libraryId,
      schemaVersion: 2,
      created: false,
      upgradedFrom: 1,
    });
  } finally {
    await application.close();
  }
  const snapshots = await readdir(join(libraryRoot, "recovery"));
  expect(snapshots).toEqual([
    expect.stringMatching(/^catalog-schema-1-before-2-.*\.sqlite$/),
  ]);
  const snapshot = new DatabaseSync(
    join(libraryRoot, "recovery", snapshots[0] ?? ""),
    {
      readOnly: true,
    },
  );
  try {
    expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  } finally {
    snapshot.close();
  }
});

test("packaged readers open a catalog book, save its position and resume it", async () => {
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
  } finally {
    await application.close();
  }
  application = await launch(profile);
  try {
    const { ui } = await read(application);
    await expect(ui.getByTestId("page-text")).toContainText("CEDAR SECOND");
  } finally {
    await application.close();
  }
  // The source file was only read.
  expect(await readFile(source)).toEqual(
    await readFile(resolve("tests/fixtures/known.pdf")),
  );
});
