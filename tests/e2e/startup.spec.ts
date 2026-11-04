import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";

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
      page.getByRole("heading", {
        name: "Development environment",
        exact: true,
      }),
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
        schemaVersion: 2,
        created: true,
        // Development builds keep the library inside their own profile.
        root: join(profile, "library"),
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
