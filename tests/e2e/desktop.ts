import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
} from "@playwright/test";

export { expect } from "@playwright/test";

export const test = base.extend<{ application: ElectronApplication }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
  application: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), "borges-desktop-"));
    let application: ElectronApplication | undefined;
    let nativeProcess: ReturnType<ElectronApplication["process"]> | undefined;
    try {
      application = await electron.launch({
        args: ["."],
        env: { ...process.env, BORGES_DEV_PROFILE: profile },
      });
      nativeProcess = application.process();
      await use(application);
    } finally {
      try {
        if (application && nativeProcess?.exitCode === null)
          await application.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  },
});
