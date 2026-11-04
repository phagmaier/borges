import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Storage modules import each other with explicit `.ts` extensions so tests can
// run them in a real child Node process (type stripping) for crash/lock checks.

export const CATALOG_FILE = "catalog.sqlite";
export const LOCK_FILE = "library.lock";
export const LOCK_OWNER_FILE = "library.lock-owner.json";
export const LIBRARY_DIRECTORIES = [
  "files",
  "covers",
  "staging",
  "recovery",
] as const;

export interface RootInputs {
  /** Explicit local-root launch configuration (`BORGES_LIBRARY_ROOT`). */
  explicitRoot?: string | undefined;
  xdgDataHome?: string | undefined;
  home: string;
  /** Development builds keep their library inside the development profile. */
  developmentProfile?: string | undefined;
}

/** Spec default: `$XDG_DATA_HOME/borges/library`, else `~/.local/share/…`. */
export function resolveLibraryRoot(inputs: RootInputs): string {
  if (inputs.explicitRoot !== undefined && inputs.explicitRoot !== "") {
    if (!isAbsolute(inputs.explicitRoot)) {
      throw new Error(
        `The configured library root must be an absolute path: ${inputs.explicitRoot}`,
      );
    }
    return resolve(inputs.explicitRoot);
  }
  if (inputs.developmentProfile !== undefined) {
    return join(inputs.developmentProfile, "library");
  }
  // XDG: relative values are invalid and must be ignored.
  const data =
    inputs.xdgDataHome && isAbsolute(inputs.xdgDataHome)
      ? inputs.xdgDataHome
      : join(inputs.home, ".local/share");
  return resolve(data, "borges/library");
}

/**
 * Durable catalog paths are `/`-separated, relative to the library root, and
 * never contain empty, `.` or `..` segments. The schema enforces the same rule.
 */
export function isLibraryPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\\\0]/.test(path)) return false;
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/** Convert an absolute path inside the root into its durable relative form. */
export function toLibraryPath(root: string, absolute: string): string {
  const path = relative(resolve(root), resolve(absolute));
  const durable = path.split(sep).join("/");
  if (isAbsolute(path) || !isLibraryPath(durable)) {
    throw new Error(`Path is outside the library root: ${absolute}`);
  }
  return durable;
}

/** Lexically resolve a durable path against the current root location. */
export function resolveLibraryPath(root: string, path: string): string {
  if (!isLibraryPath(path)) throw new Error(`Invalid library path: ${path}`);
  return join(resolve(root), ...path.split("/"));
}

/** Resolve an existing durable path, rejecting symlink escapes from the root. */
export async function resolveExistingLibraryPath(
  root: string,
  path: string,
): Promise<string> {
  const target = await realpath(resolveLibraryPath(root, path));
  const fromRoot = relative(await realpath(root), target);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Library path escapes the library root: ${path}`);
  }
  return target;
}
