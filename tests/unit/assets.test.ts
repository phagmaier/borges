import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAppAsset,
  resolveReaderAsset,
  resolveServedAsset,
} from "../../src/main/assets";

describe("application resource boundary", () => {
  it.each([
    ["borges://app/", "/build/renderer/index.html"],
    ["borges://app/assets/main.js", "/build/renderer/assets/main.js"],
    [
      "borges://app/assets/book%20cover.png",
      "/build/renderer/assets/book cover.png",
    ],
  ])("serves a local generated resource: %s", (url, expected) => {
    expect(resolveAppAsset(url, "/build/renderer")).toBe(expected);
  });

  it.each([
    "https://example.com/index.html",
    "file:///etc/passwd",
    "borges://other/index.html",
    "borges://user@app/index.html",
    "borges://app:9000/index.html",
    "borges://app/..%2f..%2fetc/passwd",
    "borges://app/%00secret",
    "borges://app/%5c..%5csecret",
    "borges://app/%zz",
    "not a URL",
  ])("rejects an unauthorized or invalid resource: %s", (url) => {
    expect(resolveAppAsset(url, "/build/renderer")).toBeNull();
  });
});

describe("reader origin resource boundary", () => {
  it.each([
    [
      "borges://reader/content.html?book=sample-pdf",
      "/build/renderer/content.html",
    ],
    ["borges://reader/assets/content.js", "/build/renderer/assets/content.js"],
    [
      "borges://reader/reader-assets/fixtures/known.pdf",
      "/build/renderer/reader-assets/fixtures/known.pdf",
    ],
  ])("serves bundled reader assets: %s", (url, expected) => {
    expect(resolveReaderAsset(url, "/build/renderer")).toBe(expected);
  });
  it.each([
    "borges://reader/index.html",
    "borges://app/content.html",
    "borges://reader:9000/content.html",
    "borges://reader/reader-assets/..%2f..%2f..%2fetc/passwd",
    "borges://reader/assets/%00x",
    "borges://user@reader/content.html",
    "file:///etc/passwd",
  ])("rejects unauthorized reader assets: %s", (url) => {
    expect(resolveReaderAsset(url, "/build/renderer")).toBeNull();
  });
});

it.each([
  "borges://reader/assets/..%2findex.html",
  "borges://reader/reader-assets/%2e%2e%2findex.html",
])("does not decode a reader path into the privileged shell: %s", (url) => {
  expect(resolveReaderAsset(url, "/build/renderer")).toBeNull();
});

it("serves approved real files and denies file/directory symlink escapes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "borges-assets-"));
  const root = join(temporary, "renderer");
  try {
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "local.css"), "body {}");
    await writeFile(join(root, "index.html"), "shell");
    await writeFile(join(temporary, "secret"), "private host bytes");
    await symlink(join(temporary, "secret"), join(root, "assets", "escape"));
    await symlink(temporary, join(root, "assets", "directory"));
    await symlink(join(root, "index.html"), join(root, "assets", "shell"));
    await symlink(
      join(root, "assets", "local.css"),
      join(root, "assets", "alias.css"),
    );
    for (const origin of ["app", "reader"]) {
      expect(
        await resolveServedAsset(`borges://${origin}/assets/local.css`, root),
      ).toBe(join(root, "assets", "local.css"));
      expect(
        await resolveServedAsset(`borges://${origin}/assets/alias.css`, root),
      ).toBe(join(root, "assets", "local.css"));
      for (const path of ["escape", "directory/secret", "missing", ""]) {
        expect(
          await resolveServedAsset(`borges://${origin}/assets/${path}`, root),
        ).toBeNull();
      }
    }
    expect(
      await resolveServedAsset("borges://reader/assets/shell", root),
    ).toBeNull();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
