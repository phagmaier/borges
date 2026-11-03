import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// Minimal Linux diagnostic artifact, using Electron's documented resources/app
// layout. Full personal-delivery launchers/desktop integration remain M6.
if (process.platform !== "linux") throw new Error("This spike targets Linux.");
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const destination = join(root, "dist/borges-runtime-check");
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
      name: "borges-runtime-check",
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
console.log(`Bundled diagnostic runtime: ${destination}/borges`);
