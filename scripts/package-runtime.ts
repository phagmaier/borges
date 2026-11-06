import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// Both artifacts use the same compiled app and pinned runtime. Diagnostic
// packaging keeps fixtures; personal delivery adds the offline launch tools.
if (process.platform !== "linux") throw new Error("This spike targets Linux.");
const personal = process.argv[2] === "--personal";
if (process.argv.length > (personal ? 3 : 2))
  throw new Error("usage: package-runtime.ts [--personal]");
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const destination = join(
  root,
  personal ? "dist/borges" : "dist/borges-runtime-check",
);
const electronRoot = dirname(require("electron") as string);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(destination, { recursive: true, force: true });
await cp(electronRoot, destination, { recursive: true, dereference: true });
await rm(join(destination, "resources/default_app.asar"), { force: true });
await rename(join(destination, "electron"), join(destination, "borges"));
const application = join(destination, "resources/app");
await mkdir(application, { recursive: true });
await cp(join(root, "out"), join(application, "out"), { recursive: true });
await writeFile(
  join(application, "package.json"),
  `${JSON.stringify(
    {
      name: personal ? "borges" : "borges-runtime-check",
      version: manifest.version,
      type: "module",
      main: "./out/main/index.js",
    },
    null,
    2,
  )}\n`,
);

// Reader/fixture notices are already copied with their assets. Keep the shell's
// bundled dependencies' notices too; Electron's own notices remain at the root.
const notices = join(application, "notices");
await mkdir(notices, { recursive: true });
const reactDomRequire = createRequire(
  require.resolve("react-dom/package.json"),
);
for (const name of ["react", "react-dom", "scheduler"]) {
  const path =
    name === "scheduler"
      ? reactDomRequire.resolve(`${name}/package.json`)
      : require.resolve(`${name}/package.json`);
  await cp(join(dirname(path), "LICENSE"), join(notices, `${name}.LICENSE`));
}
// foliate's minified ZIP helpers omit their upstream notice headers; retain
// the corresponding license texts alongside the shell notices in both builds.
await cp(join(root, "packaging/licenses"), notices, { recursive: true });
await cp(
  join(root, "node_modules/pdfjs-dist/LICENSE"),
  join(application, "out/renderer/reader-assets/foliate/vendor/pdfjs/LICENSE"),
);
if (personal) {
  await rm(join(application, "out/renderer/reader-assets/fixtures"), {
    recursive: true,
    force: true,
  });
  for (const name of [
    "launch",
    "install-desktop.cjs",
    "borges.svg",
    "THIRD_PARTY.md",
  ])
    await cp(join(root, "packaging", name), join(destination, name));
  await chmod(join(destination, "launch"), 0o755);
  await cp(join(root, "docs/user-guide.md"), join(destination, "README.md"));
  await writeFile(
    join(destination, "borges.desktop"),
    execFileSync(
      process.execPath,
      [join(destination, "install-desktop.cjs"), "--print"],
      { env: { ...process.env, BORGES_LIBRARY_ROOT: "" }, encoding: "utf8" },
    ),
  );
  await writeFile(
    join(destination, "BUILD-INFO.json"),
    `${JSON.stringify(
      {
        application: "Borges",
        version: manifest.version,
        sourceCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        electron: manifest.devDependencies.electron,
        pdfjs: manifest.dependencies["pdfjs-dist"],
        foliate: execFileSync(
          "git",
          ["-C", join(root, "vendor/foliate-js"), "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim(),
        foliateVendorSha256: Object.fromEntries(
          await Promise.all(
            ["zip.js", "fflate.js"].map(async (name) => [
              name,
              createHash("sha256")
                .update(
                  await readFile(join(root, "vendor/foliate-js/vendor", name)),
                )
                .digest("hex"),
            ]),
          ),
        ),
        lockfileSha256: createHash("sha256")
          .update(await readFile(join(root, "pnpm-lock.yaml")))
          .digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
}
console.log(
  `Bundled ${personal ? "personal application" : "diagnostic runtime"}: ${destination}/${personal ? "launch" : "borges"}`,
);
