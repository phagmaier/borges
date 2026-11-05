import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isReaderHost } from "../shared/windows";

/** Resolve only app-origin resources inside the generated renderer directory. */
export function resolveAppAsset(urlText: string, root: string): string | null {
  try {
    const url = new URL(urlText);
    if (
      url.protocol !== "borges:" ||
      url.host !== "app" ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\0") || pathname.includes("\\")) return null;
    const target = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    const fromRoot = relative(root, target);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

/** Separate content origin, restricted to its entry point and bundled assets. */
export function resolveReaderAsset(
  urlText: string,
  root: string,
): string | null {
  try {
    const url = new URL(urlText);
    if (
      !isReaderHost(url.host) ||
      url.protocol !== "borges:" ||
      url.username ||
      url.password
    )
      return null;
    url.host = "app";
    const target = resolveAppAsset(url.href, root);
    return target && isReaderPath(relative(root, target)) ? target : null;
  } catch {
    return null;
  }
}

function isReaderPath(path: string): boolean {
  return (
    path === "content.html" ||
    path.startsWith(`assets${sep}`) ||
    path.startsWith(`reader-assets${sep}`)
  );
}

/** Resolve symlinks before serving bytes; a lexical prefix is insufficient. */
export async function resolveServedAsset(
  urlText: string,
  root: string,
): Promise<string | null> {
  const target =
    resolveAppAsset(urlText, root) ?? resolveReaderAsset(urlText, root);
  if (!target) return null;
  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ]);
    const path = relative(canonicalRoot, canonicalTarget);
    if (
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path) ||
      (isReaderHost(new URL(urlText).host) && !isReaderPath(path)) ||
      !(await stat(canonicalTarget)).isFile()
    )
      return null;
    return canonicalTarget;
  } catch {
    return null;
  }
}
