const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, isAbsolute, join } = require("node:path");

// Two escaping layers: desktop string decoding, then Exec argument decoding.
// https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html
/** @param {string} value */
function stringValue(value) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject desktop-file line/control injection.
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error("Desktop paths cannot contain control characters.");
  return value.replaceAll("\\", "\\\\");
}
/** @param {string} value */
function argument(value) {
  return stringValue(
    `"${value.replace(/["`$\\]/g, (character) => `\\${character}`).replaceAll("%", "%%")}"`,
  );
}

async function main() {
  const print = process.argv[2] === "--print";
  if (process.argv.length > (print ? 3 : 2))
    throw new Error("usage: install-desktop.cjs [--print]");
  const directory = __dirname;
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  if (!isAbsolute(dataHome)) throw new Error("XDG_DATA_HOME must be absolute.");
  const library = process.env.BORGES_LIBRARY_ROOT;
  if (library && !isAbsolute(library))
    throw new Error("BORGES_LIBRARY_ROOT must be absolute.");
  const desktop = join(dataHome, "applications/borges.desktop");
  if (!print)
    try {
      const existing = await readFile(desktop, "utf8");
      if (!existing.split(/\r?\n/).includes("X-Borges-Managed=true"))
        throw new Error(
          `${desktop} already exists and was not created by Borges. Keep it or move it before registering Borges.`,
        );
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }

  // /bin/sh receives a script filename, never a shell command (-c). Special
  // characters in installation/library paths cannot become shell instructions.
  const entry = `[Desktop Entry]
Type=Application
Name=Borges
Comment=Offline PDF and EPUB library and reader
Exec=/bin/sh ${argument(join(directory, "launch"))}${library ? ` --library-root ${argument(library)}` : ""}
Icon=${stringValue(join(directory, "borges.svg"))}
Terminal=false
Categories=Office;Viewer;
StartupNotify=true
X-Borges-Managed=true
`;
  if (print) {
    process.stdout.write(entry);
    return;
  }
  await mkdir(dirname(desktop), { recursive: true });
  const temporary = `${desktop}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, entry, { flag: "wx", mode: 0o644 });
    await rename(temporary, desktop);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(
    `Registered Borges: ${desktop}\nRun this command again after moving the application directory.`,
  );
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
