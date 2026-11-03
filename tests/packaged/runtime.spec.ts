import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";

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

function environment() {
  return {
    ...process.env,
    PATH: "/usr/bin:/bin",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    ELECTRON_RUN_AS_NODE: "",
    // A packaged app must use its local bundle even with a stray dev setting.
    ELECTRON_RENDERER_URL: "http://127.0.0.1:1",
    BORGES_DEV_PROFILE: profile,
  };
}

async function launch() {
  return electron.launch({ executablePath, args: [], cwd, env: environment() });
}

test("relocated bundled runtime commits SQLite across real process restarts", async () => {
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    const library = await application.firstWindow();
    await expect(library.getByTestId("launch-count")).toHaveText("1");
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
    const firstRuntime = await library.evaluate(() =>
      window.development.getRuntimeInfo(),
    );
    expect(firstRuntime).toMatchObject({
      electron: "45.2.1",
      node: "24.22.1",
      sqlite: "3.53.4",
      sandboxed: true,
      contextIsolated: true,
      database: {
        schemaVersion: 1,
        launchCount: 1,
        marker: "Borges SQLite runtime probe",
      },
    });
    await library.reload();
    await expect(library.getByTestId("launch-count")).toHaveText("1");
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

    const path = join(profile, "runtime-check.sqlite");
    const database = new DatabaseSync(path);
    try {
      expect(
        database.prepare("SELECT launch_count FROM runtime_probe").get()
          ?.launch_count,
      ).toBe(1);
      // Independent input proves startup preserves an existing record.
      database
        .prepare("UPDATE runtime_probe SET marker = ?")
        .run("Persisted across restart — 蘭");
    } finally {
      database.close();
    }

    application = await launch();
    const reopened = await application.firstWindow();
    await expect(reopened.getByTestId("launch-count")).toHaveText("2");
    const restored = await reopened.evaluate(() =>
      window.development.getRuntimeInfo(),
    );
    expect(restored.database).toMatchObject({
      schemaVersion: 1,
      launchCount: 2,
      marker: "Persisted across restart — 蘭",
    });
  } finally {
    await application?.close();
  }
});

for (const scenario of [
  {
    name: "newer schema",
    sql: "PRAGMA user_version = 2; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep this');",
    error: "Unsupported runtime diagnostic schema 2",
  },
  {
    name: "damaged supported schema",
    sql: "PRAGMA user_version = 1; CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep this too');",
    error: "no such table: runtime_probe",
  },
]) {
  test(`packaged startup refuses ${scenario.name} and retains the database`, async () => {
    const path = join(profile, "runtime-check.sqlite");
    const database = new DatabaseSync(path);
    database.exec(scenario.sql);
    database.close();
    const before = await readFile(path);
    let stderr = "";
    const child = spawn(executablePath, [], {
      cwd,
      env: environment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(1);
      expect(stderr).toContain(scenario.error);
      expect(await readFile(path)).toEqual(before);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
}
