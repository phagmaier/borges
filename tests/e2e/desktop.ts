import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
} from "@playwright/test";

export { expect } from "@playwright/test";

/** A catalog book added before launch: fixture file or literal content, and the name it imports as. */
export type CatalogSeed = { name: string } & (
  | { fixture: string }
  | { content: string }
);

/** Launch the built app on a development profile (and its library). */
export function launch(
  profile: string,
  env: Record<string, string> = {},
): Promise<ElectronApplication> {
  return electron.launch({
    // Optional backend selection for platform checks, e.g.
    // BORGES_ELECTRON_FLAGS=--ozone-platform=wayland.
    args: [
      ...(process.env.BORGES_ELECTRON_FLAGS?.split(" ").filter(Boolean) ?? []),
      ".",
    ],
    env: { ...process.env, ...env, BORGES_DEV_PROFILE: profile },
  });
}

/** Import seeds through the real publication path; returns title → book ID. */
export async function seedCatalog(
  profile: string,
  seeds: CatalogSeed[],
): Promise<Record<string, string>> {
  if (seeds.length === 0) return {};
  const sources = await mkdtemp(join(tmpdir(), "borges-seed-"));
  try {
    const paths: string[] = [];
    for (const seed of seeds) {
      const path = join(sources, seed.name);
      if ("fixture" in seed)
        await copyFile(resolve("tests/fixtures", seed.fixture), path);
      else await writeFile(path, seed.content);
      paths.push(path);
    }
    const { stdout } = await promisify(execFile)(process.execPath, [
      resolve("tests/unit/storage-child.ts"),
      "add-books",
      join(profile, "library"),
      ...paths,
    ]);
    return JSON.parse(stdout);
  } finally {
    await rm(sources, { recursive: true, force: true });
  }
}

export const test = base.extend<{
  /** Wrapped in an object: Playwright reads a bare array as [value, options]. */
  catalog: { books: CatalogSeed[] };
  environment: Record<string, string>;
  profile: string;
  seeded: Record<string, string>;
  application: ElectronApplication;
}>({
  catalog: [{ books: [] }, { option: true }],
  environment: [{}, { option: true }],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
  profile: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), "borges-desktop-"));
    try {
      await use(profile);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  seeded: async ({ profile, catalog }, use) => {
    await use(await seedCatalog(profile, catalog.books));
  },
  application: async ({ profile, seeded, environment }, use) => {
    void seeded; // Seed before launch.
    const application = await launch(profile, environment);
    const nativeProcess = application.process();
    try {
      await use(application);
    } finally {
      if (nativeProcess.exitCode === null && nativeProcess.signalCode === null)
        await application.close();
    }
  },
});
