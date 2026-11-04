import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";
import { openLibrary } from "../../src/storage/catalog";
import { kill, startChild } from "../unit/library-fixtures";

test("built desktop shell loads with sandboxed UI and its locked development catalog", async () => {
  const profile = await mkdtemp(join(tmpdir(), "borges-smoke-"));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."],
      env: { ...process.env, BORGES_DEV_PROFILE: profile },
    });
    const page = await application.firstWindow();
    await expect(
      page.getByRole("navigation", { name: "Library" }),
    ).toBeVisible();
    await expect(page.getByTestId("sqlite-version")).toHaveText(
      /^\d+\.\d+\.\d+$/,
    );
    expect(
      await page.evaluate(() => typeof Reflect.get(globalThis, "require")),
    ).toBe("undefined");
    const diagnostics = await page.evaluate(() =>
      window.development.getRuntimeInfo(),
    );
    expect(diagnostics).toMatchObject({
      sandboxed: true,
      contextIsolated: true,
      catalog: {
        schemaVersion: 3,
        created: true,
        // Development builds keep the library inside their own profile.
        root: join(profile, "library"),
        reconciliation: { rolledBack: 0, retained: 0, unrecognized: 0 },
      },
    });
    expect(diagnostics.catalog.libraryId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readdir(join(profile, "library"))).sort()).toEqual([
      "catalog.sqlite",
      "catalog.sqlite-shm",
      "catalog.sqlite-wal",
      "covers",
      "files",
      "library.lock",
      "library.lock-journal",
      "library.lock-owner.json",
      "recovery",
      "staging",
    ]);
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    await page.reload();
    await expect(page.getByTestId("sqlite-version")).toHaveText(
      /^\d+\.\d+\.\d+$/,
    );

    await expect(page.getByTestId("library-id")).toHaveText(
      diagnostics.catalog.libraryId,
    );
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
});

test("startup rolls back an import killed mid-copy before any window opens", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "borges-reconcile-"));
  const root = join(temporary, "library");
  const source = join(temporary, "Interrupted.pdf");
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.alloc(2 * 1024 * 1024, 0x41),
  ]);
  let application: ElectronApplication | undefined;
  try {
    await writeFile(source, bytes);
    // A real Node process starts the import and is killed during the copy.
    await kill(
      await startChild(
        "import-and-stop",
        root,
        "at copying",
        source,
        "copying",
      ),
    );
    expect(await readdir(join(root, "staging"))).toHaveLength(1);
    await writeFile(join(root, "files", "stray.pdf"), "%PDF-1.4\n");

    application = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        BORGES_DEV_PROFILE: join(temporary, "profile"),
        BORGES_LIBRARY_ROOT: root,
      },
    });
    const page = await application.firstWindow();
    const diagnostics = await page.evaluate(() =>
      window.development.getRuntimeInfo(),
    );
    expect(diagnostics.catalog).toMatchObject({
      root,
      created: false,
      reconciliation: { rolledBack: 1, retained: 0, unrecognized: 1 },
    });
    const report = page.getByRole("region", { name: "Startup problems" });
    await expect(report).toBeVisible();
    await expect(report).toContainText(root);
    await expect(report).toContainText("files/stray.pdf");
    await page.reload();
    await expect(report).toContainText("files/stray.pdf");
    await application.close();
    application = undefined;

    expect(await readdir(join(root, "staging"))).toEqual([]);
    // Unrecognized files are reported, never deleted.
    expect(await readdir(join(root, "files"))).toEqual(["stray.pdf"]);
    const catalog = new DatabaseSync(join(root, "catalog.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        catalog
          .prepare("SELECT state FROM recovery_operations")
          .all()
          .map((row) => row.state),
      ).toEqual(["abandoned"]);
      expect(catalog.prepare("SELECT id FROM books").all()).toEqual([]);
    } finally {
      catalog.close();
    }
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test("retained recovery diagnostics remain visible while the library stays usable", async () => {
  const profile = await mkdtemp(join(tmpdir(), "borges-repair-"));
  const root = join(profile, "library");
  const path = join(root, "staging/unfinished.partial");
  const reason = 'unexpected digest <img src="https://example.invalid/leak">';
  const seeded = openLibrary({ root });
  seeded.database
    .prepare(`INSERT INTO recovery_operations
    (id, kind, state, staged_path, detail, created_at, updated_at)
    VALUES ('unfinished', 'import', 'failed', 'staging/unfinished.partial', ?, 1, 1)`)
    .run(JSON.stringify({ reason, retained: ["staging/unfinished.partial"] }));
  seeded.close();
  await writeFile(path, "uncertain bytes");
  let application = await electron.launch({
    args: ["."],
    env: { ...process.env, BORGES_DEV_PROFILE: profile },
  });
  try {
    const page = await application.firstWindow();
    const report = page.getByRole("region", { name: "Startup problems" });
    await expect(report).toContainText(
      "Operation unfinished still needs repair",
    );
    await expect(report).toContainText(reason);
    await expect(report).toContainText("staging/unfinished.partial");
    await expect(report.locator("img")).toHaveCount(0);
    await page
      .getByRole("button", { name: "New section", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "New section name" })
      .fill("Still usable");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Still usable/ }),
    ).toBeVisible();
    await page.reload();
    await expect(report).toContainText(reason);
    expect(await readFile(path, "utf8")).toBe("uncertain bytes");
    await page.screenshot({ path: "test-results/startup-recovery.png" });
    await application.close();
    application = await electron.launch({
      args: ["."],
      env: { ...process.env, BORGES_DEV_PROFILE: profile },
    });
    const restarted = await application.firstWindow();
    await expect(
      restarted.getByRole("region", { name: "Startup problems" }),
    ).toContainText(reason);
    expect(await readFile(path, "utf8")).toBe("uncertain bytes");
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a reconciliation failure is explained without preventing library browsing", async () => {
  const profile = await mkdtemp(join(tmpdir(), "borges-reconcile-failure-"));
  const root = join(profile, "library");
  openLibrary({ root }).close();
  // Opening the catalog succeeds; scanning the managed directory really fails.
  await chmod(join(root, "files"), 0o300);
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."],
      env: { ...process.env, BORGES_DEV_PROFILE: profile },
    });
    const page = await application.firstWindow();
    const report = page.getByRole("region", { name: "Startup problems" });
    await expect(report).toContainText("could not be reconciled");
    await expect(report).toContainText("EACCES");
    await expect(
      page.getByRole("heading", { name: "All Books" }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => window.development.getRuntimeInfo())).catalog
        .reconciliation,
    ).toBeNull();
  } finally {
    await application?.close();
    await chmod(join(root, "files"), 0o700);
    await rm(profile, { recursive: true, force: true });
  }
});
