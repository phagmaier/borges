import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execute = promisify(execFile);
let root: string;
let bundle: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "borges-delivery-"));
  bundle = join(root, 'Borges space $quote`"\\%name');
  await mkdir(bundle);
  await cp(resolve("packaging/launch"), join(bundle, "launch"));
  await cp(
    resolve("packaging/install-desktop.cjs"),
    join(bundle, "install-desktop.cjs"),
  );
  await chmod(join(bundle, "launch"), 0o755);
  // Record the real arguments/environment received after the launcher execs.
  // Installer mode runs its actual script with the available Node runtime.
  await writeFile(
    join(bundle, "borges"),
    `#!/bin/sh
if [ "\u0024{ELECTRON_RUN_AS_NODE-}" = 1 ]; then exec '${process.execPath.replaceAll("'", "'\\''")}' "\u0024@"; fi
exec '${process.execPath.replaceAll("'", "'\\''")}' '${resolve("tests/unit/delivery-recorder.ts")}' "\u0024@"
`,
    { mode: 0o755 },
  );
  env = {
    ...process.env,
    XDG_DATA_HOME: join(root, "data"),
    BORGES_LIBRARY_ROOT: "",
    DELIVERY_RECORD: join(root, "record.json"),
  };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it("relocates, preserves arguments and library paths, and removes development/Node overrides", async () => {
  await execute(
    join(bundle, "launch"),
    [
      "--library-root",
      join(root, "library with spaces"),
      "--remote-debugging-port=0",
    ],
    {
      cwd: "/",
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--throw-deprecation",
        NODE_PATH: "/wrong",
        ELECTRON_RENDERER_URL: "http://wrong",
        BORGES_DEV_PROFILE: "/wrong",
      },
    },
  );
  expect(
    JSON.parse(await readFile(env.DELIVERY_RECORD as string, "utf8")),
  ).toEqual({
    args: ["--remote-debugging-port=0"],
    root: join(root, "library with spaces"),
    overrides: {},
  });
});

it("rejects a relative or missing root before launching", async () => {
  for (const args of [["--library-root", "relative"], ["--library-root"]])
    await expect(
      execute(join(bundle, "launch"), args, { env }),
    ).rejects.toMatchObject({ code: 64 });
  await expect(readFile(env.DELIVERY_RECORD as string)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("generates the bundled desktop entry without registering anything during a build", async () => {
  const result = await execute(
    process.execPath,
    [join(bundle, "install-desktop.cjs"), "--print"],
    { env },
  );
  const desktop = join(root, "bundle.desktop");
  await writeFile(desktop, result.stdout);
  await execute("desktop-file-validate", [desktop]);
  await expect(
    readFile(join(env.XDG_DATA_HOME as string, "applications/borges.desktop")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("registers an offline desktop entry that GLib launches with literal paths and the selected root", async () => {
  await execute(
    join(bundle, "launch"),
    ["--library-root", join(root, 'books $`"\\%folder'), "--install-desktop"],
    { env },
  );
  const desktop = join(
    env.XDG_DATA_HOME as string,
    "applications/borges.desktop",
  );
  await execute("desktop-file-validate", [desktop]);
  await execute("gio", ["launch", desktop], { env });
  await expect
    .poll(async () =>
      JSON.parse(await readFile(env.DELIVERY_RECORD as string, "utf8")),
    )
    .toMatchObject({
      args: [],
      root: join(root, 'books $`"\\%folder'),
    });
  expect(await readFile(desktop, "utf8")).toContain("X-Borges-Managed=true");
});

it("refreshes its own desktop entry after relocation and preserves an unrelated existing entry", async () => {
  await execute(join(bundle, "launch"), ["--install-desktop"], { env });
  const moved = join(root, "moved Borges");
  await cp(bundle, moved, { recursive: true });
  await execute(join(moved, "launch"), ["--install-desktop"], { env });
  const desktop = join(
    env.XDG_DATA_HOME as string,
    "applications/borges.desktop",
  );
  expect(await readFile(desktop, "utf8")).toContain(moved);
  await writeFile(desktop, "[Desktop Entry]\nName=Keep me\n");
  await expect(
    execute(join(moved, "launch"), ["--install-desktop"], { env }),
  ).rejects.toThrow();
  expect(await readFile(desktop, "utf8")).toBe(
    "[Desktop Entry]\nName=Keep me\n",
  );
});
