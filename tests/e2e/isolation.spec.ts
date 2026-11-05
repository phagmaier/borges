import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "./desktop";

// Substitute bytes at the existing diagnostic fixture boundary. The product
// does not gain an arbitrary file loader for this test.
test("adversarial EPUB cannot execute scripts or navigate out of the book", async ({
  application,
}) => {
  const bytes = await readFile("tests/fixtures/malicious.epub");
  await application
    .context()
    .route("**/reader-assets/fixtures/reflowable.epub", (route) =>
      route.fulfill({ body: bytes, contentType: "application/epub+zip" }),
    );
  const library = await application.firstWindow();
  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-epub")),
  ]);
  const surface = reader.frameLocator('iframe[title="Book content"]');
  await expect(surface.getByRole("status")).toHaveText("Ready");
  const engine = reader
    .frames()
    .find((frame) => frame.url().startsWith("borges://reader/"));
  const chapter = reader
    .frames()
    .find((frame) => frame.url().startsWith("blob:borges://reader/"));
  if (!engine || !chapter) throw new Error("Missing reader frames");
  await expect(chapter.locator("body")).toContainText("ORCHID EPUB FIRST");
  expect(
    await chapter
      .getByAltText("Coral square")
      .evaluate(
        (image: HTMLImageElement) =>
          image.complete && image.naturalWidth === 24,
      ),
  ).toBe(true);
  expect(
    await chapter.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some(
        (font) => font.family === "Fixture" && font.status === "loaded",
      );
    }),
  ).toBe(true);
  for (const frame of [reader.mainFrame(), engine, chapter]) {
    expect(
      await frame.evaluate(() => Reflect.get(window, "bookScriptRan")),
    ).toBeUndefined();
  }
  expect(
    await chapter
      .locator(
        "script,iframe,object,embed,base,meta[http-equiv=refresh],link[rel=preconnect],link[rel=dns-prefetch]",
      )
      .count(),
  ).toBe(0);
  await expect(chapter.locator("#javascript")).not.toHaveAttribute("href");
  const chapterUrl = chapter.url();
  for (const id of [
    "external",
    "shell",
    "mailto",
    "file",
    "data",
    "download",
  ]) {
    await chapter.locator(`#${id}`).click();
    if (["external", "mailto"].includes(id)) {
      const reference = reader.getByRole("dialog", {
        name: "External reference",
      });
      await expect(reference).toBeVisible();
      await reference
        .getByRole("button", { name: "Close", exact: true })
        .click();
    }
    expect(chapter.url()).toBe(chapterUrl);
    expect(reader.url()).toBe("borges://app/index.html");
    expect(application.windows()).toHaveLength(2);
  }
  await chapter.getByRole("button", { name: "Submit book form" }).click();
  expect(reader.url()).toBe("borges://app/index.html");
  expect(chapter.url()).toBe(chapterUrl);
  expect(
    await chapter.evaluate(() => Reflect.get(window, "bookScriptRan")),
  ).toBeUndefined();
  // Stripping active elements must leave search locators aligned with the
  // rendered chapter, rather than offsets into the unsanitized source DOM.
  await surface.getByRole("button", { name: "Search", exact: true }).click();
  const query = surface.getByRole("searchbox");
  await query.fill("REMOTE RESOURCE PROBE");
  await expect(surface.locator("#search-status")).toHaveText("1 matches");
  await query.press("Enter");
  await expect
    .poll(() => chapter.evaluate(() => document.getSelection()?.toString()))
    .toBe("REMOTE RESOURCE PROBE");
});

test("real protocol serving confines decoded paths and file/directory symlinks", async ({
  application,
}) => {
  // Launch can return before main has installed the protocol/offline handlers.
  // Exercise that boundary only once the normal startup has completed.
  const library = await application.firstWindow();
  await expect(library.getByTestId("library-id")).toHaveText(/^[0-9a-f-]{36}$/);
  const temporary = await mkdtemp(join(tmpdir(), "borges-escape-"));
  const name = `isolation-${process.pid}`;
  const assets = resolve("out/renderer/assets");
  try {
    await writeFile(join(temporary, "secret"), "HOST SECRET MUST NOT LEAK");
    await symlink(join(temporary, "secret"), join(assets, name));
    await symlink(temporary, join(assets, `${name}-dir`));
    await symlink(
      resolve("out/renderer/index.html"),
      join(assets, `${name}-shell`),
    );
    const responses = await application.evaluate(async ({ net }, prefix) => {
      const urls = [
        `borges://reader/assets/${prefix}`,
        `borges://app/assets/${prefix}`,
        `borges://reader/assets/${prefix}-dir/secret`,
        `borges://reader/assets/${prefix}-shell`,
        "borges://reader/assets/..%2findex.html",
        "borges://reader/reader-assets/..%2f..%2f..%2fetc/passwd",
      ];
      return Promise.all(
        urls.map(async (url) => {
          const response = await net.fetch(url);
          return { status: response.status, text: await response.text() };
        }),
      );
    }, name);
    for (const response of responses)
      expect(response).toEqual({ status: 403, text: "" });
  } finally {
    for (const suffix of ["", "-dir", "-shell"])
      await rm(join(assets, `${name}${suffix}`), { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test("offline session denies network requests before they reach a real endpoint", async ({
  application,
}) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end("network probe");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test endpoint");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${endpoint}/control`);
    expect(requests).toEqual(["/control"]);
    const result = await application.evaluate(async ({ net }, url) => {
      try {
        await net.fetch(`${url}/blocked`);
        return "allowed";
      } catch (error) {
        return String(error);
      }
    }, endpoint);
    expect(result).toContain("ERR_BLOCKED_BY_CLIENT");
    const library = await application.firstWindow();
    const [reader] = await Promise.all([
      application.waitForEvent("window"),
      library.evaluate(() => window.development.openReader("sample-epub")),
    ]);
    await expect(
      reader.frameLocator('iframe[title="Book content"]').getByRole("status"),
    ).toHaveText("Ready");
    const chapter = reader
      .frames()
      .find((frame) => frame.url().startsWith("blob:borges://reader/"));
    if (!chapter) throw new Error("Missing chapter");
    expect(
      await chapter.evaluate(async (url) => {
        const image = new Image();
        const imageResult = new Promise<string>((resolve) => {
          image.onload = () => resolve("loaded");
          image.onerror = () => resolve("denied");
        });
        image.src = `${url}/image.png`;
        document.body.append(image);
        const css = document.createElement("link");
        css.rel = "stylesheet";
        const cssResult = new Promise<string>((resolve) => {
          css.onload = () => resolve("loaded");
          css.onerror = () => resolve("denied");
        });
        css.href = `${url}/style.css`;
        document.head.append(css);
        const font = new FontFace("RemoteProbe", `url(${url}/font.woff2)`);
        const fontResult = font.load().then(
          () => "loaded",
          () => "denied",
        );
        const fetchResult = fetch(`${url}/fetch`).then(
          () => "loaded",
          () => "denied",
        );
        return Promise.all([imageResult, cssResult, fontResult, fetchResult]);
      }, endpoint),
    ).toEqual(["denied", "denied", "denied", "denied"]);

    expect(
      await library.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "geolocation" })).state,
      ),
    ).toBe("denied");
    expect(requests).toEqual(["/control"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("book frames have no bridge and forged/replayed progress messages have no authority", async ({
  application,
}) => {
  const library = await application.firstWindow();
  const [pdf] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-pdf")),
  ]);
  const pdfSurface = pdf.frameLocator('iframe[title="Book content"]');
  await expect(pdfSurface.getByRole("status")).toHaveText("Ready");
  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-epub")),
  ]);
  const surface = reader.frameLocator('iframe[title="Book content"]');
  await expect(surface.getByRole("status")).toHaveText("Ready");
  const chapter = reader
    .frames()
    .find((frame) => frame.url().startsWith("blob:borges://reader/"));
  if (!chapter) throw new Error("Missing chapter");
  expect(
    await chapter.evaluate(() => ({
      bridge: typeof Reflect.get(window, "development"),
      node: typeof Reflect.get(window, "require"),
      ipc: typeof Reflect.get(window, "ipcRenderer"),
    })),
  ).toEqual({ bridge: "undefined", node: "undefined", ipc: "undefined" });
  await chapter.evaluate(() => {
    for (const generation of [0, 1, 999]) {
      const message = {
        type: "progress",
        bookId: "sample-pdf",
        revisionId: "forged",
        generation,
        sequence: 999,
        location: { format: "pdf", page: 3 },
      };
      parent.postMessage(message, "*");
      top?.postMessage(message, "*");
      top?.postMessage(
        { type: "development:open-reader", bookId: "sample-pdf" },
        "*",
      );
    }
  });
  await expect(surface.locator("#location")).toContainText("Chapter 1");
  // Close/reopen produces a new engine/document. Diagnostic fixture readers
  // hold no progress session, so replayed messages still have no authority.
  // Catalog-book sessions are checked in catalog-readers.spec.ts.
  await expect(pdfSurface.locator("#location")).toHaveText("Page 1 of 3");
  await reader.close();
  const [fresh] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-epub")),
  ]);
  await expect(
    fresh.frameLocator('iframe[title="Book content"]').getByRole("status"),
  ).toHaveText("Ready");
  await fresh.evaluate(() =>
    window.postMessage(
      { type: "progress", bookId: "sample-epub", generation: 0, sequence: 999 },
      "*",
    ),
  );
  expect(application.windows()).toHaveLength(3);
  await expect(
    fresh.frameLocator('iframe[title="Book content"]').locator("#location"),
  ).toContainText("Chapter 1");
});

test("reader subframes cannot replace their assigned engine via navigation", async ({
  application,
}) => {
  const library = await application.firstWindow();
  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate(() => window.development.openReader("sample-epub")),
  ]);
  const surface = reader.frameLocator('iframe[title="Book content"]');
  await expect(surface.getByRole("status")).toHaveText("Ready");
  const engine = reader
    .frames()
    .find((frame) => frame.url().startsWith("borges://reader/"));
  if (!engine) throw new Error("Missing engine");
  const original = engine.url();
  const native = await application.browserWindow(reader);
  await native.evaluate((window) => {
    window.webContents.once(
      "will-frame-navigate",
      (event: { url: string; defaultPrevented: boolean }) => {
        Reflect.set(window, "isolationNavigation", {
          url: event.url,
          prevented: event.defaultPrevented,
        });
      },
    );
  });
  await engine.evaluate(() => {
    location.href = "borges://reader/content.html?book=sample-pdf";
  });
  await expect
    .poll(() =>
      native.evaluate((window) => Reflect.get(window, "isolationNavigation")),
    )
    .toEqual({
      url: "borges://reader/content.html?book=sample-pdf",
      prevented: true,
    });
  expect(engine.url()).toBe(original);
  await expect(surface.locator("#location")).toContainText("Chapter 1");
});
