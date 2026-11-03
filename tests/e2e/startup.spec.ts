import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";

test("built desktop shell loads with sandboxed UI and working embedded SQLite", async () => {
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
      database: { schemaVersion: 1, launchCount: 1 },
    });
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    await page.reload();
    await expect(page.getByTestId("sqlite-version")).toHaveText(
      /^\d+\.\d+\.\d+$/,
    );

    await expect(page.getByTestId("launch-count")).toHaveText("1");
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
});
