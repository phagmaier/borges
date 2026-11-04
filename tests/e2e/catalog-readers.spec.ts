import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, launch, test } from "./desktop";

// Catalog books opened in real reader windows. Positions travel engine →
// reader shell → main, are bound to the sending window's session, coalesced
// and committed centrally. Expected values come from the known fixtures.

test.use({
  catalog: {
    books: [
      { fixture: "known.pdf", name: "Known PDF.pdf" },
      { fixture: "reflowable.epub", name: "Reflowable EPUB.epub" },
    ],
  },
});

function catalog<T>(profile: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(
    join(profile, "library", "catalog.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    return read(database);
  } finally {
    database.close();
  }
}

interface Stored {
  status: string;
  generation: number;
  revision: string;
  page: number | null;
  cfi: string | null;
  sequence: number | null;
  fontSize: number | null;
}
function stored(profile: string, bookId: string): Stored {
  return catalog(profile, (database) => {
    const row = database
      .prepare(
        `SELECT b.reading_status AS status, b.session_generation AS generation,
           b.current_revision_id AS revision, p.pdf_page AS page,
           p.epub_cfi AS cfi, p.sequence AS sequence, s.font_size AS fontSize
         FROM books b
         LEFT JOIN positions p ON p.revision_id = b.current_revision_id
         LEFT JOIN reader_settings s ON s.book_id = b.id
         WHERE b.id = ?`,
      )
      .get(bookId);
    if (!row) throw new Error(`no book ${bookId}`);
    return { ...row } as unknown as Stored;
  });
}

async function openCatalogReader(
  application: ElectronApplication,
  title: string,
) {
  const library = await application.firstWindow();
  const opened = application.waitForEvent("window");
  await library.getByRole("button", { name: `Read ${title}` }).click();
  const reader = await opened;
  const ui = reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByRole("status")).toHaveText("Ready");
  return { library, reader, ui };
}

/** Wait until the reader shell shows an acknowledged save. */
async function acknowledged(reader: Page, atLeast = 1) {
  await expect
    .poll(async () =>
      Number(
        await reader.getByTestId("save-status").getAttribute("data-sequence"),
      ),
    )
    .toBeGreaterThanOrEqual(atLeast);
}

test("catalog readers save positions centrally and resume after reopening and restart", async ({
  application,
  profile,
  seeded,
}) => {
  const pdf = seeded["Known PDF"] as string;
  const epub = seeded["Reflowable EPUB"] as string;
  expect(stored(profile, pdf)).toMatchObject({ status: "unread", page: null });

  const first = await openCatalogReader(application, "Known PDF");
  await expect(first.ui.getByTestId("page-text")).toContainText("ORCHID FIRST");
  await expect.poll(() => stored(profile, pdf).status).toBe("reading");
  const surface = first.ui.getByRole("region", { name: "Reading surface" });
  await surface.focus();
  await surface.press("ArrowRight");
  await surface.press("ArrowRight");
  await expect(first.ui.getByTestId("page-text")).toContainText("HARBOR THIRD");
  await expect.poll(() => stored(profile, pdf).page).toBe(3);
  await acknowledged(first.reader);
  await expect(first.reader.getByTestId("save-status")).toContainText(
    "Position saved",
  );
  await first.library.reload();
  await expect(first.library.getByTestId(`status-${pdf}`)).toHaveText(
    "Currently Reading",
  );

  // A second, independent reader with its own position and font size.
  const second = await openCatalogReader(application, "Reflowable EPUB");
  await second.ui.getByRole("button", { name: "Search", exact: true }).click();
  const query = second.ui.getByRole("searchbox");
  await query.fill("LANTERN PASSAGE 24.");
  await expect(second.ui.locator("#search-status")).toHaveText("1 matches");
  await query.press("Enter");
  await query.press("Escape");
  await second.ui.getByRole("spinbutton", { name: "Font size" }).fill("24");
  await second.ui.getByRole("spinbutton", { name: "Font size" }).press("Tab");
  await expect(second.ui.getByTestId("visible-text")).toContainText(
    "LANTERN PASSAGE 24.",
  );
  await expect
    .poll(() => stored(profile, epub))
    .toMatchObject({ fontSize: 24, cfi: expect.stringMatching(/^epubcfi\(/) });
  expect(stored(profile, pdf).page).toBe(3);

  // Reopening a closed reader resumes it.
  await first.reader.close();
  const reopened = await openCatalogReader(application, "Known PDF");
  await expect(reopened.ui.getByTestId("page-text")).toContainText(
    "HARBOR THIRD",
  );

  // Both positions survive a real process restart.
  await application.close();
  const restarted = await launch(profile);
  try {
    const pdfAgain = await openCatalogReader(restarted, "Known PDF");
    await expect(pdfAgain.ui.getByTestId("page-text")).toContainText(
      "HARBOR THIRD",
    );
    const epubAgain = await openCatalogReader(restarted, "Reflowable EPUB");
    await expect(epubAgain.ui.getByTestId("visible-text")).toContainText(
      "LANTERN PASSAGE 24.",
    );
    await expect(
      epubAgain.ui.getByRole("spinbutton", { name: "Font size" }),
    ).toHaveValue("24");
    await expect(
      epubAgain.reader.getByTestId("restoration-notice"),
    ).toHaveCount(0);
  } finally {
    await restarted.close();
  }

  // A damaged locator falls back to the saved chapter with a notice.
  const writable = new DatabaseSync(join(profile, "library", "catalog.sqlite"));
  writable
    .prepare(
      "UPDATE positions SET epub_cfi = 'broken locator' WHERE revision_id = ?",
    )
    .run(stored(profile, epub).revision);
  writable.close();
  const third = await launch(profile);
  try {
    const fallback = await openCatalogReader(third, "Reflowable EPUB");
    await expect(
      fallback.reader.getByTestId("restoration-notice"),
    ).toContainText("nearest saved chapter position");
    await expect(fallback.ui.getByTestId("visible-text")).not.toContainText(
      "ORCHID EPUB FIRST",
    );
  } finally {
    await third.close();
  }
});

test("the library window queries the catalog; malformed queries and readers are refused", async ({
  application,
}) => {
  const library = await application.firstWindow();
  const query = (page: Page, input: unknown) =>
    page.evaluate(
      (value) =>
        window.borges.library.books(value as never).then(
          (books) => books.map((book) => book.title),
          (error: unknown) => `rejected: ${String(error)}`,
        ),
      input,
    );
  expect(await query(library, undefined)).toEqual([
    "Known PDF",
    "Reflowable EPUB",
  ]);
  expect(
    await query(library, { view: { kind: "all" }, text: "  REFLOWABLE " }),
  ).toEqual(["Reflowable EPUB"]);
  expect(await query(library, { view: { kind: "archive" } })).toEqual([]);
  expect(await query(library, { view: { kind: "everything" } })).toContain(
    "Unknown library view.",
  );
  expect(await query(library, { view: { kind: "all" }, text: 7 })).toContain(
    "Search text must be short text.",
  );
  const { reader } = await openCatalogReader(application, "Known PDF");
  expect(await query(reader, undefined)).toContain(
    "Only the library window may list books.",
  );
});

test.describe("flushing", () => {
  // Commits would otherwise wait 10 s, so a saved position proves the flush.
  test.use({ environment: { BORGES_SAVE_INTERVAL_MS: "10000" } });

  test("closing a reader and Quit save the latest position immediately", async ({
    application,
    profile,
    seeded,
  }) => {
    const pdf = seeded["Known PDF"] as string;
    const { reader, ui } = await openCatalogReader(application, "Known PDF");
    await expect(ui.locator("#location")).toHaveText("Page 1 of 3");
    const surface = ui.getByRole("region", { name: "Reading surface" });
    await surface.focus();
    await surface.press("ArrowRight");
    // The engine reports a page when it has finished drawing it.
    await expect(ui.locator("#location")).toHaveText("Page 2 of 3");
    await reader.waitForTimeout(100);
    expect(stored(profile, pdf).page).toBeNull(); // Nothing committed yet.
    await reader.close();
    await expect.poll(() => stored(profile, pdf).page).toBe(2);

    const again = await openCatalogReader(application, "Known PDF");
    await expect(again.ui.getByTestId("page-text")).toContainText(
      "CEDAR SECOND",
    );
    const turn = again.ui.getByRole("region", { name: "Reading surface" });
    await turn.focus();
    await turn.press("ArrowRight");
    await expect(again.ui.locator("#location")).toHaveText("Page 3 of 3");
    await again.reader.waitForTimeout(100);
    expect(stored(profile, pdf).page).toBe(2);
    const exited = new Promise((done) =>
      application.process().once("exit", done),
    );
    await again.reader.evaluate(() => window.development.quit());
    await exited;
    expect(stored(profile, pdf).page).toBe(3);
  });
});

test("forged, stale, replayed and malformed progress writes are rejected end to end", async ({
  application,
  profile,
  seeded,
}) => {
  const pdf = seeded["Known PDF"] as string;
  const epub = seeded["Reflowable EPUB"] as string;
  const pdfReader = await openCatalogReader(application, "Known PDF");
  await acknowledged(pdfReader.reader);
  const epubReader = await openCatalogReader(application, "Reflowable EPUB");
  await acknowledged(epubReader.reader);
  const before = stored(profile, pdf);
  expect(before.page).toBe(1);

  /** Send reports from a page and collect the results it is told about. */
  async function send(page: Page, reports: object[]) {
    return page.evaluate(async (list) => {
      const seen: { ok: boolean; code?: string }[] = [];
      const stop = window.borges.reader.onProgressResult((result) =>
        seen.push(result.ok ? { ok: true } : { ok: false, code: result.code }),
      );
      for (const report of list)
        window.borges.reader.reportProgress(report as never);
      const deadline = Date.now() + 3000;
      while (seen.length < list.length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      stop();
      return seen.map((result) => result.code ?? "ok");
    }, reports);
  }
  const write = (overrides: object) => ({
    bookId: pdf,
    revisionId: before.revision,
    generation: before.generation,
    sequence: 999,
    location: { format: "pdf", page: 3, x: 0, y: 0 },
    sizing: { fontSize: 18, zoom: 1 },
    ...overrides,
  });

  // Another book's reader shell forging this book's position.
  expect(await send(epubReader.reader, [write({})])).toEqual(["not-assigned"]);
  // The library window has no reader session at all.
  expect(await send(pdfReader.library, [write({})])).toEqual(["not-assigned"]);
  // The assigned window, but stale, replayed or malformed.
  expect(
    await send(pdfReader.reader, [
      write({ generation: before.generation + 1 }),
      write({ sequence: before.sequence }),
      write({ location: { format: "pdf", page: 0, x: 0, y: 0 } }),
      write({
        location: {
          format: "epub",
          cfi: "x",
          section: 0,
          fraction: 0,
          x: 0,
          y: 0,
        },
      }),
    ]),
  ).toEqual(["stale-session", "out-of-order", "invalid", "invalid"]);
  expect(stored(profile, pdf)).toEqual(before);
  await expect(pdfReader.reader.getByRole("alert")).toContainText(
    "Position not saved",
  );

  // Book content frames have no bridge, and the shell ignores positions
  // posted by a chapter document instead of its assigned engine.
  const chapter = epubReader.reader
    .frames()
    .find((frame) => frame.url().startsWith("blob:borges://reader/"));
  const engine = epubReader.reader
    .frames()
    .find((frame) => frame.url() === "borges://reader/content.html?catalog");
  if (!chapter || !engine) throw new Error("Missing EPUB frames");
  for (const frame of [chapter, engine])
    expect(
      await frame.evaluate(() => ({
        borges: typeof Reflect.get(window, "borges"),
        development: typeof Reflect.get(window, "development"),
      })),
    ).toEqual({ borges: "undefined", development: "undefined" });
  const epubBefore = stored(profile, epub);
  const sequenceBefore = await epubReader.reader
    .getByTestId("save-status")
    .getAttribute("data-sequence");
  await chapter.evaluate(() => {
    const message = {
      type: "borges:position",
      location: {
        format: "epub",
        cfi: "epubcfi(/6/2!/4/2)",
        section: 0,
        fraction: 0.9,
        x: 0,
        y: 0,
      },
      sizing: { fontSize: 40, zoom: 1 },
    };
    parent.postMessage(message, "*");
    top?.postMessage(message, "*");
    top?.postMessage({ type: "borges:opened", restoration: "beginning" }, "*");
  });
  await epubReader.reader.waitForTimeout(600); // Longer than the save interval.
  expect(stored(profile, epub)).toEqual(epubBefore);
  await expect(epubReader.reader.getByTestId("save-status")).toHaveAttribute(
    "data-sequence",
    sequenceBefore ?? "",
  );
  await expect(epubReader.reader.getByTestId("restoration-notice")).toHaveCount(
    0,
  );

  // A reload starts a new session; the previous page's identity is stale.
  await pdfReader.reader.reload();
  await expect(
    pdfReader.reader
      .frameLocator('iframe[title="Book content"]')
      .getByRole("status"),
  ).toHaveText("Ready");
  await expect
    .poll(() => stored(profile, pdf).generation)
    .toBeGreaterThan(before.generation);
  await acknowledged(pdfReader.reader);
  expect(
    await send(pdfReader.reader, [
      write({ generation: before.generation, sequence: 1000 }),
    ]),
  ).toEqual(["stale-session"]);
  expect(stored(profile, pdf).page).toBe(1);
});

test.describe("failed opens", () => {
  test.use({
    catalog: {
      books: [
        { fixture: "known.pdf", name: "Known PDF.pdf" },
        { content: "%PDF-1.7\nnot really a PDF\n", name: "Broken PDF.pdf" },
      ],
    },
  });

  test("leave status unchanged and report the error in the reader", async ({
    application,
    profile,
    seeded,
  }) => {
    const broken = seeded["Broken PDF"] as string;
    const library = await application.firstWindow();
    const opened = application.waitForEvent("window");
    await library.getByRole("button", { name: "Read Broken PDF" }).click();
    const reader = await opened;
    await expect(reader.getByRole("alert")).toContainText(
      "could not be opened",
    );
    expect(stored(profile, broken)).toMatchObject({
      status: "unread",
      page: null,
    });

    // A missing managed file is reported; its catalog entry stays.
    const pdf = seeded["Known PDF"] as string;
    const path = catalog(profile, (database) =>
      String(
        database
          .prepare(
            "SELECT r.path FROM books b JOIN revisions r ON r.id = b.current_revision_id WHERE b.id = ?",
          )
          .get(pdf)?.path,
      ),
    );
    await rm(join(profile, "library", path));
    const missing = application.waitForEvent("window");
    await library.getByRole("button", { name: "Read Known PDF" }).click();
    const missingReader = await missing;
    await expect(missingReader.getByRole("alert")).toContainText(
      "could not be read from the library",
    );
    expect(stored(profile, pdf)).toMatchObject({ status: "unread" });
  });
});
