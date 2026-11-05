import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Frame,
  type Page,
  test,
} from "@playwright/test";
import {
  buildCatalog,
  CATALOG_SIZE,
  type CatalogEntry,
  catalogEntries,
  LARGE_EPUB,
  LARGE_PDF,
  plan,
  queries,
  readSince,
  resetAccessTimes,
  SECTIONS,
} from "./catalog";
import {
  COMMON_WORD,
  EPUB_OPENING,
  PDF_OPENING,
  RARE_WORD,
  type RepresentativeDocument,
  representativeEpub,
  representativePdf,
} from "./representative";

// Packaged-artifact measurements on this Arch desktop (A13): a representative
// 500-entry catalog on the home disk, with two of its book-length entries open
// in catalog readers. The catalog plan (tests/measure/catalog.ts) and the
// document generator supply every expected count.
const report: Record<string, unknown> = {};
let root: string;
let executablePath: string;
let libraryRoot: string;
let entries: Map<string, CatalogEntry>;
let pdf: RepresentativeDocument;
let epub: RepresentativeDocument;
const live = plan.filter((book) => !book.archived).length;

// Budgets come from the recorded runs in docs/development.md (M1-07, then the
// A13 catalog runs): roughly 2–3× the worst observation, so ordinary noise
// passes while a real regression (eager loading, a leaked renderer, blocking
// search) fails. The position acknowledgement budget is the spec's one-second
// persistence target. Recalibrate from new evidence; never loosen for a pass.
const budgets = {
  firstRunLaunchMs: 8000,
  catalogWarmLaunchMedianMs: 1500,
  catalogWarmCoversMedianMs: 2000,
  catalogEvictedLaunchMaxMs: 7000,
  catalogEvictedCoversMaxMs: 8000,
  catalogQueryP95Ms: 50,
  readerOpenMaxMs: 1500,
  pageTurnP95Ms: 300,
  positionAcknowledgedMaxMs: 1000,
  firstSearchHitMs: 250,
  pdfFullSearchMs: 3500,
  epubFullSearchMs: 1000,
  rendererExitMaxMs: 1000,
  libraryIdlePssMiB: 400,
  // M3-08: two complete cover traversals retained 743–778 MiB before GC.
  // This separate budget includes those caches; idle/reader limits stay put.
  libraryBrowsedPssMiB: 1600,
  twoReadersPssMiB: 800,
  closedReadersOverIdleMiB: 60,
  openCloseCycleGrowthMiB: 100,
};

test.beforeAll(async () => {
  test.setTimeout(600_000); // Seeding commits ~4,300 transactions on the HDD.
  // Relocate onto the same filesystem a personal install would use, not the
  // tmpfs default temp directory; dist/ is ignored by Git.
  await mkdir(resolve("dist"), { recursive: true });
  root = await mkdtemp(resolve("dist/measure-"));
  const artifact = join(root, "borges");
  await cp(resolve("dist/borges-runtime-check"), artifact, { recursive: true });
  executablePath = join(artifact, "borges");
  libraryRoot = join(root, "library");
  // Development shortcut: a closed library previously built from this plan
  // (copied, never used in place). Reported, so such runs are identifiable.
  const template = process.env.BORGES_MEASURE_CATALOG;
  let seedMs: number | null = null;
  if (template) await cp(template, libraryRoot, { recursive: true });
  else seedMs = await buildCatalog(libraryRoot);
  entries = catalogEntries(libraryRoot);
  // Distinct assets prevent a shared thumbnail/cache from hiding eager loads.
  const covers = [...entries.values()].flatMap((entry) =>
    entry.coverPath ? [entry.coverPath] : [],
  );
  expect(covers).toHaveLength(400);
  expect(new Set(covers).size).toBe(400);
  pdf = representativePdf();
  epub = representativeEpub();
  // The large entries are the generator's default documents.
  expect(entries.get(LARGE_PDF)?.size).toBe(pdf.bytes.length);
  expect(entries.get(LARGE_EPUB)?.size).toBe(epub.bytes.length);
  const sizes = [...entries.values()].map((entry) => entry.size);
  const coverBytes = await Promise.all(
    covers.map(async (path) => (await stat(join(libraryRoot, path))).size),
  );
  report.catalog = {
    entries: entries.size,
    pdf: plan.filter((book) => book.format === "pdf").length,
    epub: plan.filter((book) => book.format === "epub").length,
    archived: CATALOG_SIZE - live,
    unfiled: plan.filter((book) => book.sections.length === 0).length,
    sections: SECTIONS.length,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
    smallestBytes: Math.min(...sizes),
    largestBytes: Math.max(...sizes),
    covers: covers.length,
    missingCovers: entries.size - covers.length,
    coverBytes: coverBytes.reduce((sum, size) => sum + size, 0),
    seedMs:
      seedMs === null ? "copied from BORGES_MEASURE_CATALOG" : round(seedMs),
  };
  report.documents = Object.fromEntries(
    Object.entries({ pdf, epub }).map(([name, { bytes, ...rest }]) => [
      name,
      { bytes: bytes.length, ...rest },
    ]),
  );
});
test.afterAll(async () => {
  report.budgets = budgets;
  const path = resolve(
    process.env.BORGES_MEASURE_REPORT ?? "dist/measurements/latest.json",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Measurement report: ${path}`);
  if (root) await rm(root, { recursive: true, force: true });
});

async function launch(profile: string, library = "") {
  return electron.launch({
    executablePath,
    args: [],
    cwd: root,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      NODE_OPTIONS: "",
      ELECTRON_RUN_AS_NODE: "",
      ELECTRON_RENDERER_URL: "",
      BORGES_DEV_PROFILE: profile,
      // Keep the packaged default library inside the measurement profile.
      XDG_DATA_HOME: join(profile, "data"),
      BORGES_LIBRARY_ROOT: library,
    },
  });
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}
const within = (value: number, budget: number, name: string) =>
  expect.soft(value, `${name} ≤ ${budget}`).toBeLessThanOrEqual(budget);

/** Proportional set size per Electron process, from the kernel, in MiB. */
async function memory(application: ElectronApplication) {
  const metrics = await application.evaluate(({ app }) =>
    app.getAppMetrics().map(({ pid, type, memory }) => ({
      pid,
      type,
      rssKiB: memory.workingSetSize,
    })),
  );
  const processes = await Promise.all(
    metrics.map(async (metric) => {
      const rollup = await readFile(
        `/proc/${metric.pid}/smaps_rollup`,
        "utf8",
      ).catch(() => "");
      const pss = /^Pss:\s+(\d+) kB/m.exec(rollup)?.[1];
      // A process that exited between the two reads is reported, not summed.
      return { ...metric, pssMiB: pss ? round(Number(pss) / 1024) : null };
    }),
  );
  return {
    totalPssMiB: round(processes.reduce((sum, p) => sum + (p.pssMiB ?? 0), 0)),
    processes,
  };
}

/** The library renderer's own view: JS heap and DOM size. */
async function libraryRenderer(library: Page) {
  return library.evaluate(() => {
    const heap = Reflect.get(performance, "memory") as
      | { usedJSHeapSize: number; totalJSHeapSize: number }
      | undefined;
    return {
      usedHeapMiB: heap ? Math.round(heap.usedJSHeapSize / 2 ** 17) / 8 : null,
      totalHeapMiB: heap
        ? Math.round(heap.totalJSHeapSize / 2 ** 17) / 8
        : null,
      domNodes: document.getElementsByTagName("*").length,
    };
  });
}

async function settle() {
  // Let GC/compositor work finish after an action before sampling memory.
  await new Promise((done) => setTimeout(done, 1500));
}

/** Books the library renders before more are requested (`RESULT_BATCH`). */
const RESULT_BATCH = 100;

/** The library window once it counts every live entry and shows a batch. */
async function catalogShown(library: Page, expected: number) {
  await expect(library.getByTestId("library-id")).toHaveText(
    /^[0-9a-f-]{36}$/,
    { timeout: 30_000 },
  );
  await expect(library.locator(".result-count")).toHaveText(
    `${expected} books`,
    { timeout: 30_000 },
  );
  await expect(
    library.getByRole("list", { name: "Books" }).getByRole("listitem"),
  ).toHaveCount(Math.min(expected, RESULT_BATCH), { timeout: 30_000 });
}

/** All viewport-visible cards with planned covers have decoded images. The
 * missing-cover cards must continue to use placeholders. */
async function coversShown(library: Page) {
  await expect
    .poll(
      () =>
        library.evaluate(
          (titles) => {
            const viewport = document
              .querySelector(".library-main")
              ?.getBoundingClientRect();
            if (!viewport) return false;
            let decoded = 0;
            for (const card of document.querySelectorAll(".book-card")) {
              const cover = card.querySelector(".cover");
              const bounds = cover?.getBoundingClientRect();
              if (
                !bounds ||
                bounds.bottom <= viewport.top ||
                bounds.top >= viewport.bottom
              )
                continue;
              const expected = titles.includes(
                card.querySelector(".title")?.textContent ?? "",
              );
              const image = cover?.querySelector("img");
              if (expected) {
                if (!image?.complete || !image.naturalWidth) return false;
                decoded++;
              } else if (image) return false;
            }
            return decoded > 0;
          },
          plan.filter((book) => book.cover).map((book) => book.title),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Scroll rather than click the sentinel: entering its margin can load a
 * batch and remove the button while Playwright is trying to click it. */
async function showAllBooks(library: Page, expected: number) {
  const rows = library.locator(".book-card, .book-list tbody tr");
  while ((await rows.count()) < expected) {
    const before = await rows.count();
    await library.locator(".library-main").evaluate((main) => {
      main.scrollTop = main.scrollHeight;
    });
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
  await expect(rows).toHaveCount(expected);
}

function stored(sql: string, ...values: string[]) {
  const database = new DatabaseSync(join(libraryRoot, "catalog.sqlite"), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).all(...values);
  } finally {
    database.close();
  }
}

/** Each planned query through the library window's IPC; counts are checked. */
async function timeQueries(library: Page, repetitions: number) {
  const results: Record<string, ReturnType<typeof summary>> = {};
  for (const { name, query, count } of queries) {
    const run = await library.evaluate(
      async ({ query, repetitions }) => {
        const times: number[] = [];
        let found = -1;
        for (let i = 0; i < repetitions; i++) {
          const started = performance.now();
          const result = await window.borges.library.books(query as never);
          found = result.ok ? result.value.length : -1;
          times.push(performance.now() - started);
        }
        return { times, found };
      },
      { query, repetitions },
    );
    expect(run.found, name).toBe(count);
    results[name] = summary(run.times);
  }
  return results;
}

async function openReader(
  application: ElectronApplication,
  library: Page,
  title: string,
  opened: (reader: Page, ui: ReturnType<Page["frameLocator"]>) => Promise<void>,
) {
  const started = performance.now();
  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library
      .getByRole("list", { name: "Books" })
      .getByRole("button", { name: title, exact: true })
      .click(),
  ]);
  const ui = reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByRole("status")).toHaveText("Ready", { timeout: 30_000 });
  await opened(reader, ui);
  const elapsed = performance.now() - started;
  // Shell renderer and the separate-origin content frame's renderer.
  const { pid, contentPid } = await application.evaluate(
    ({ BrowserWindow }, title) => {
      const contents = BrowserWindow.getAllWindows().find((window) =>
        window.getTitle().startsWith(`${title} — `),
      )?.webContents;
      return {
        pid: contents?.getOSProcessId(),
        contentPid: contents?.mainFrame.frames.find((frame) =>
          frame.url.startsWith("borges://reader/"),
        )?.osProcessId,
      };
    },
    title,
  );
  return { reader, ui, elapsed, pid, contentPid };
}

const pdfOpening = async (_: Page, ui: ReturnType<Page["frameLocator"]>) =>
  expect(ui.getByTestId("page-text")).toContainText(PDF_OPENING);
async function epubOpening(reader: Page) {
  await expect
    .poll(async () => {
      try {
        return (await chapter(reader).locator("h1").textContent()) ?? "";
      } catch {
        return ""; // chapter frame not created yet
      }
    })
    .toBe(EPUB_OPENING);
}

function chapter(reader: Page): Frame {
  const frame = reader
    .frames()
    .find((candidate) => candidate.url().startsWith("blob:borges://reader/"));
  if (!frame) throw new Error("Missing EPUB chapter frame");
  return frame;
}

/** Each turn waits for a real change: the PDF's exact page label, or the
 * EPUB's visible text range differing from the previous page's. */
async function turns(
  ui: ReturnType<Page["frameLocator"]>,
  count: number,
  expected?: (turn: number) => RegExp,
) {
  const surface = ui.getByRole("region", { name: "Reading surface" });
  const visible = ui.getByTestId("visible-text");
  await surface.focus();
  const times: number[] = [];
  const seen = new Set<string>();
  for (let turn = 1; turn <= count; turn++) {
    const before = (await visible.textContent()) ?? "";
    seen.add(before);
    const started = performance.now();
    await surface.press("ArrowRight");
    if (expected)
      await expect(ui.locator("#location")).toHaveText(expected(turn));
    else
      await expect
        .poll(async () => (await visible.textContent()) ?? "", {
          intervals: [10],
        })
        .not.toBe(before);
    times.push(performance.now() - started);
  }
  const final = (await visible.textContent()) ?? "";
  // Distinct pages, not a flicker back to an earlier one.
  expect(seen.has(final)).toBe(false);
  expect(seen.size).toBe(count);
  return times;
}

const savedSequence = async (reader: Page) =>
  Number(await reader.getByTestId("save-status").getAttribute("data-sequence"));

/**
 * From a quiet reader, turn once and time until the shell shows that main
 * committed a newer position: page turn, report, coalescing, commit, reply.
 */
async function acknowledgedTurns(
  reader: Page,
  ui: ReturnType<Page["frameLocator"]>,
  count: number,
) {
  const surface = ui.getByRole("region", { name: "Reading surface" });
  const visible = ui.getByTestId("visible-text");
  await surface.focus();
  const times: number[] = [];
  for (let turn = 0; turn < count; turn++) {
    await reader.waitForTimeout(400); // Past the 250 ms coalescing interval.
    const before = await savedSequence(reader);
    const text = (await visible.textContent()) ?? "";
    const started = performance.now();
    await surface.press("ArrowRight");
    await expect
      .poll(async () => (await visible.textContent()) ?? "", { intervals: [5] })
      .not.toBe(text);
    await expect
      .poll(() => savedSequence(reader), { intervals: [5], timeout: 5000 })
      .toBeGreaterThan(before);
    times.push(performance.now() - started);
  }
  await expect(reader.getByTestId("save-status")).toContainText(
    "Position saved",
  );
  return times;
}

async function search(
  ui: ReturnType<Page["frameLocator"]>,
  query: string,
  expected: number,
) {
  const input = ui.getByRole("searchbox", { name: "Search text" });
  if (!(await input.isVisible()))
    await ui.getByRole("button", { name: "Search", exact: true }).click();
  if (await input.inputValue()) {
    await input.fill("");
    await expect(ui.locator("#search-status")).toHaveText("Enter search text.");
  }
  const started = performance.now();
  await input.fill(query);
  await expect(ui.locator("#results li").first()).toBeVisible({
    timeout: 60_000,
  });
  const firstHit = performance.now() - started;
  await expect(ui.locator("#search-status")).toHaveText(`${expected} matches`, {
    timeout: 60_000,
  });
  return {
    firstHitMs: round(firstHit),
    totalMs: round(performance.now() - started),
  };
}

test.describe.configure({ mode: "serial" });

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.error}`);
  return result.stdout;
}

/** Drop the artifact's, profiles' and library's clean pages from the page
 * cache. Shared system libraries stay cached, so this is a partial cold start. */
async function evict() {
  run("sync", ["-f", root]);
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of files)
    if (entry.isFile())
      run("dd", [
        `if=${join(entry.parentPath, entry.name)}`,
        "iflag=nocache",
        "count=0",
        "status=none",
      ]);
  // Independent check (util-linux) that the executable is no longer resident.
  expect(
    run("fincore", [
      "--bytes",
      "--noheadings",
      "--output",
      "RES",
      executablePath,
    ]).trim(),
  ).toBe("0");
}

test("first-run, warm and evicted-cache launches with a 500-entry catalog", async () => {
  // A fresh profile creates its empty library on the first launch.
  const fresh = await mkdtemp(join(root, "fresh-profile-"));
  const empty: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = performance.now();
    const application = await launch(fresh);
    try {
      const library = await application.firstWindow();
      await expect(library.getByTestId("library-id")).toHaveText(
        /^[0-9a-f-]{36}$/,
        { timeout: 30_000 },
      );
      await expect(
        library.getByText("No books have been added to this library yet."),
      ).toBeVisible();
      empty.push(performance.now() - started);
    } finally {
      await application.close();
    }
  }

  const profile = await mkdtemp(join(root, "catalog-profile-"));
  await resetAccessTimes(libraryRoot);
  await resetAccessTimes(libraryRoot, "covers");
  const warm: number[] = [];
  const warmCovers: number[] = [];
  const evictedCovers: number[] = [];
  const evicted: number[] = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    const cold = attempt >= 6;
    if (cold) await evict();
    const started = performance.now();
    const application = await launch(profile, libraryRoot);
    try {
      const library = await application.firstWindow();
      await catalogShown(library, live);
      // The first catalog launch warms caches after seeding; not recorded.
      if (attempt > 0)
        (cold ? evicted : warm).push(performance.now() - started);
      await coversShown(library);
      if (attempt > 0)
        (cold ? evictedCovers : warmCovers).push(performance.now() - started);
    } finally {
      await application.close();
    }
  }
  // Listing the catalog never reads a book file (A13: no eager loading).
  const read = await readSince(libraryRoot);
  expect(read).toEqual([]);
  const coversRead = await readSince(libraryRoot, "covers");
  expect(coversRead.length).toBeGreaterThan(0);
  expect(coversRead.length).toBeLessThan(40);

  report.launchMs = {
    firstRunFreshProfile: round(empty[0] ?? 0),
    emptyLibraryWarm: summary(empty.slice(1)),
    catalogWarm: summary(warm),
    catalogEvicted: summary(evicted),
    catalogWarmWithCovers: summary(warmCovers),
    catalogEvictedWithCovers: summary(evictedCovers),
    coverFilesReadByLaunches: coversRead.length,
    bookFilesReadByLaunches: read.length,
    note: `Wall time from launch until the library window shows the locked, validated catalog identity and lists all ${live} unarchived entries of the ${CATALOG_SIZE}-entry catalog (or the empty-library message), including Playwright launch/CDP attach. Eviction uses POSIX_FADV_DONTNEED on artifact/profile/library files; system libraries remain cached.`,
  };
  within(empty[0] ?? Infinity, budgets.firstRunLaunchMs, "first-run launch");
  within(
    summary(warm).median,
    budgets.catalogWarmLaunchMedianMs,
    "catalog warm launch median",
  );
  within(
    Math.max(...evicted),
    budgets.catalogEvictedLaunchMaxMs,
    "catalog evicted launch",
  );
  within(
    summary(warmCovers).median,
    budgets.catalogWarmCoversMedianMs,
    "warm launch with decoded covers",
  );
  within(
    Math.max(...evictedCovers),
    budgets.catalogEvictedCoversMaxMs,
    "evicted launch with decoded covers",
  );
});

test("cover-bearing grid: bounded decoding, scrolling disposal and compact list", async () => {
  const profile = await mkdtemp(join(root, "cover-profile-"));
  const application = await launch(profile, libraryRoot);
  try {
    const library = await application.firstWindow();
    await catalogShown(library, live);
    await library.setViewportSize({ width: 1000, height: 720 });
    await coversShown(library);
    // Observe real blob ownership and image decoding without adding a product
    // diagnostics API. A short decode delay makes overlapping jobs observable.
    await library.addInitScript(() => {
      const urls = new Set<string>();
      const stats = {
        created: 0,
        revoked: 0,
        live: 0,
        peakLive: 0,
        decoding: 0,
        peakDecoding: 0,
      };
      Reflect.set(window, "coverMeasurements", stats);
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        urls.add(url);
        stats.created++;
        stats.live = urls.size;
        stats.peakLive = Math.max(stats.peakLive, stats.live);
        return url;
      };
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        if (urls.delete(url)) stats.revoked++;
        stats.live = urls.size;
        revoke(url);
      };
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        stats.decoding++;
        stats.peakDecoding = Math.max(stats.peakDecoding, stats.decoding);
        try {
          await new Promise((done) => setTimeout(done, 25));
          await decode.call(this);
        } finally {
          stats.decoding--;
        }
      };
    });
    await resetAccessTimes(libraryRoot);
    await resetAccessTimes(libraryRoot, "covers");
    await library.reload();
    await catalogShown(library, live);
    await coversShown(library);
    const stats = () =>
      library.evaluate(
        () =>
          Reflect.get(window, "coverMeasurements") as {
            created: number;
            revoked: number;
            live: number;
            peakLive: number;
            decoding: number;
            peakDecoding: number;
          },
      );
    const initial = await stats();
    expect(initial.live).toBeGreaterThan(0);
    expect((await readSince(libraryRoot, "covers")).length).toBeLessThan(40);
    const first = library
      .locator(".book-card")
      .filter({ has: library.locator(".cover img") })
      .first();
    const firstTitle = await first.locator(".title").textContent();
    const firstCard = library
      .locator(".book-card")
      .filter({ has: library.getByText(firstTitle ?? "", { exact: true }) });

    const started = performance.now();
    await showAllBooks(library, live);
    const allBatchesMs = performance.now() - started;
    await expect(library.locator(".book-card")).toHaveCount(live);
    await expect(firstCard.locator("img")).toHaveCount(0);
    // Traverse every row (including the auto-loaded batches). Each step waits
    // for visible images, so skipping or never decoding covers cannot pass.
    const browse = async () => {
      await library.locator(".library-main").evaluate((main) => {
        main.scrollTop = 0;
      });
      for (;;) {
        await coversShown(library);
        const atEnd = await library
          .locator(".library-main")
          .evaluate((main) => {
            if (main.scrollTop + main.clientHeight >= main.scrollHeight - 1)
              return true;
            main.scrollTop += main.clientHeight - 100;
            return false;
          });
        if (atEnd) break;
      }
    };
    await browse();
    await expect.poll(async () => (await stats()).decoding).toBe(0);
    const coverFilesRead = await readSince(libraryRoot, "covers");
    const expectedPaths = plan
      .filter((book) => book.cover && !book.archived)
      .map((book) => entries.get(book.title)?.coverPath)
      .sort();
    expect(coverFilesRead).toEqual(expectedPaths);
    const browsed = await stats();
    expect(browsed.peakDecoding).toBeGreaterThan(1);
    expect(browsed.peakDecoding).toBeLessThanOrEqual(4);
    expect(browsed.peakLive).toBeLessThan(40);
    expect(browsed.revoked).toBeGreaterThan(0);
    await firstCard.scrollIntoViewIfNeeded();
    await coversShown(library);
    await expect(firstCard.locator("img")).toBeVisible();
    await settle();
    const gridMemory = await memory(application);
    const renderer = await libraryRenderer(library);
    await browse();
    await firstCard.scrollIntoViewIfNeeded();
    await coversShown(library);
    await settle();
    const secondBrowseMemory = await memory(application);
    await library.screenshot({ path: "test-results/measure-covers.png" });
    // List mode owns no images and must not touch cover files, including when
    // all 429 results are requested or the list is scrolled.
    await library.getByRole("button", { name: "List", exact: true }).click();
    await expect.poll(async () => (await stats()).live).toBe(0);
    await resetAccessTimes(libraryRoot, "covers");
    await showAllBooks(library, live);
    await library.locator(".library-main").evaluate((main) => {
      main.scrollTop = main.scrollHeight;
    });
    await settle();
    const listMemory = await memory(application);
    expect(await readSince(libraryRoot, "covers")).toEqual([]);
    expect((await stats()).created).toBe((await stats()).revoked);
    await library.getByRole("button", { name: "Grid", exact: true }).click();
    await library.locator(".library-main").evaluate((main) => {
      main.scrollTop = 0;
    });
    await coversShown(library);
    expect(await readSince(libraryRoot)).toEqual([]);
    report.covers = {
      initial,
      browsed,
      afterReturningToGrid: await stats(),
      coverFilesRead: coverFilesRead.length,
      allBatchesMs: round(allBatchesMs),
      gridMemory,
      secondBrowseMemory,
      listMemory,
      renderer,
      note: "Distinct generated PNGs, fixed 1000×720 viewport. Blob/decode instrumentation adds a 25 ms decode delay to expose concurrency; launch and reader timings are uninstrumented. Full-grid PSS includes rendering caches; a second traversal and list-mode sample show their retention.",
    };
    within(
      Math.max(gridMemory.totalPssMiB, secondBrowseMemory.totalPssMiB),
      budgets.libraryBrowsedPssMiB,
      "browsed cover grid PSS",
    );
  } finally {
    await application.close();
  }
});

test("two catalog readers in a 500-entry catalog: open, turns, saves, searches, memory and disposal", async () => {
  const profile = await mkdtemp(join(root, "reader-profile-"));
  await resetAccessTimes(libraryRoot);
  const application = await launch(profile, libraryRoot);
  try {
    report.session = {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: round(totalmem() / 2 ** 30),
      kernel: release(),
      wayland: process.env.WAYLAND_DISPLAY ?? null,
      desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      ...(await application.evaluate(async ({ app, screen }) => ({
        displays: screen.getAllDisplays().map(({ size, scaleFactor }) => ({
          ...size,
          scaleFactor,
        })),
        gpu: await app.getGPUInfo("basic"),
        gpuFeatureStatus: app.getGPUFeatureStatus(),
        versions: {
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          node: process.versions.node,
        },
      }))),
    };
    const library = await application.firstWindow();
    await catalogShown(library, live);
    await coversShown(library);
    // Idle is sampled after browsing, so the library renderer's own query
    // garbage is not later attributed to the readers.
    const queriesIdle = await timeQueries(library, 20);
    await settle();
    const idle = await memory(application);
    const libraryIdle = await libraryRenderer(library);
    // No book is rendered in the background: the library is the only page.
    expect(idle.processes.filter((p) => p.type === "Tab")).toHaveLength(1);

    // Find the two books by searching, as in any library of this size.
    await library.getByRole("searchbox").fill("Representative");
    await expect(
      library.getByRole("list", { name: "Books" }).getByRole("listitem"),
    ).toHaveCount(2);

    const first = await openReader(application, library, LARGE_PDF, pdfOpening);
    const second = await openReader(
      application,
      library,
      LARGE_EPUB,
      (reader) => epubOpening(reader),
    );
    await settle();
    const opened = await memory(application);

    const pdfTurns = await turns(
      first.ui,
      20,
      (turn) => new RegExp(`^Page ${turn + 1} of ${pdf.units}$`),
    );
    // Locate the rendered page by its known heading, not only the label.
    await expect(first.ui.getByTestId("page-text")).toContainText(
      "Page heading 21",
    );
    const epubTurns = await turns(second.ui, 20);
    await expect(second.ui.locator("#location")).not.toHaveText(
      "Chapter 1 · 0%",
    );
    const pdfSaves = await acknowledgedTurns(first.reader, first.ui, 5);
    const epubSaves = await acknowledgedTurns(second.reader, second.ui, 5);
    const [pdfEntry, epubEntry] = [LARGE_PDF, LARGE_EPUB].map((title) => {
      const entry = entries.get(title);
      if (!entry) throw new Error(`Missing ${title}`);
      return entry;
    }) as [CatalogEntry, CatalogEntry];
    expect(
      stored(
        "SELECT p.pdf_page AS page FROM books b JOIN positions p ON p.revision_id = b.current_revision_id WHERE b.id = ?",
        pdfEntry.id,
      ),
    ).toEqual([{ page: 26 }]);
    // Library queries while both readers are open.
    const queriesReading = await timeQueries(library, 20);

    const pdfCommon = await search(first.ui, COMMON_WORD, pdf.commonCount);
    const pdfRare = await search(first.ui, RARE_WORD, 1);
    await first.ui.locator("#results button").first().click();
    await expect(first.ui.locator("#location")).toHaveText(
      `Page ${pdf.rareLocation} of ${pdf.units}`,
    );
    const epubCommon = await search(second.ui, COMMON_WORD, epub.commonCount);
    const epubRare = await search(second.ui, RARE_WORD, 1);
    await second.ui.locator("#results button").first().click();
    const epubRareLocation = new RegExp(
      `^Chapter ${epub.rareLocation} · \\d+%$`,
    );
    await expect(second.ui.locator("#location")).toHaveText(epubRareLocation);
    await settle();
    const searched = await memory(application);

    // Only the two opened entries changed status or gained a position.
    expect(
      stored(
        "SELECT reading_status AS status, count(*) AS books FROM books GROUP BY reading_status ORDER BY status",
      ),
    ).toEqual([
      { status: "reading", books: 2 },
      { status: "unread", books: CATALOG_SIZE - 2 },
    ]);
    expect(
      stored(
        "SELECT b.id AS id FROM positions p JOIN books b ON b.current_revision_id = p.revision_id ORDER BY b.id",
      ),
    ).toEqual([pdfEntry.id, epubEntry.id].sort().map((id) => ({ id })));

    // Disposal: closing each reader must end its renderer and return memory.
    const exitTimes: number[] = [];
    const pids = new Set(
      (await memory(application)).processes.map((p) => p.pid),
    );
    for (const { reader, pid } of [first, second]) {
      expect(pid && pids.has(pid)).toBeTruthy();
      const started = performance.now();
      await reader.close();
      await expect
        .poll(
          async () =>
            (await memory(application)).processes.some((p) => p.pid === pid),
          { timeout: 10_000, intervals: [50] },
        )
        .toBe(false);
      exitTimes.push(performance.now() - started);
    }
    // Both books' content frames may share one same-site renderer; it must
    // also end once no reader uses it.
    for (const pid of new Set([first.contentPid, second.contentPid]))
      await expect
        .poll(
          async () =>
            (await memory(application)).processes.some((p) => p.pid === pid),
          { timeout: 10_000, intervals: [50] },
        )
        .toBe(false);
    // Closing flushed the rare-hit positions.
    expect(
      stored(
        "SELECT p.pdf_page AS page FROM books b JOIN positions p ON p.revision_id = b.current_revision_id WHERE b.id = ?",
        pdfEntry.id,
      ),
    ).toEqual([{ page: pdf.rareLocation }]);
    await settle();
    const closed = await memory(application);
    const libraryClosed = await libraryRenderer(library);

    // Repeated open/close cycles: warm resumed opens and growth after disposal.
    const warm = { pdf: [] as number[], epub: [] as number[] };
    const cycles = Number(process.env.BORGES_MEASURE_CYCLES ?? 5);
    const series: {
      totalPssMiB: number;
      browserPssMiB: number;
      mainHeapMiB: number;
    }[] = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      const a = await openReader(application, library, LARGE_PDF, (_, ui) =>
        expect(ui.locator("#location")).toHaveText(
          `Page ${pdf.rareLocation} of ${pdf.units}`,
        ),
      );
      const b = await openReader(application, library, LARGE_EPUB, (_, ui) =>
        expect(ui.locator("#location")).toHaveText(epubRareLocation),
      );
      warm.pdf.push(a.elapsed);
      warm.epub.push(b.elapsed);
      await a.reader.close();
      await b.reader.close();
      await settle();
      const sample = await memory(application);
      series.push({
        totalPssMiB: sample.totalPssMiB,
        browserPssMiB:
          sample.processes.find((p) => p.type === "Browser")?.pssMiB ?? 0,
        mainHeapMiB: round(
          (await application.evaluate(() => process.memoryUsage().heapUsed)) /
            2 ** 20,
        ),
      });
    }
    await settle();
    const cycled = await memory(application);
    const libraryCycled = await libraryRenderer(library);
    const windows = await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    expect(windows).toBe(1);

    // Browse the whole catalog after the reader measurements, so this
    // reclaimable rendering cache is not charged to reader disposal: clear
    // the search, then request every batch until all are listed.
    await library.getByRole("searchbox").fill("");
    await expect(library.locator(".result-count")).toHaveText(`${live} books`);
    const browseStarted = performance.now();
    await showAllBooks(library, live);
    await expect(
      library.getByRole("list", { name: "Books" }).getByRole("listitem"),
    ).toHaveCount(live);
    const browseMs = performance.now() - browseStarted;
    await settle();
    const browsed = await memory(application);
    const libraryBrowsed = await libraryRenderer(library);

    // Exactly the two opened books' files were read (A13: no eager loading);
    // this also shows that the access-time check detects reads.
    const read = await readSince(libraryRoot);
    expect(read).toEqual([pdfEntry.path, epubEntry.path].sort());

    report.libraryBrowseMs = {
      allBatches: round(browseMs),
      note: `Showing all ${live} entries in batches of ${RESULT_BATCH} by scrolling.`,
    };
    report.catalogQueriesMs = {
      libraryIdle: queriesIdle,
      twoReadersOpen: queriesReading,
      note: "Library-window IPC round trip (renderer performance.now) for each planned query, 20 repetitions; result counts checked against the plan.",
    };
    report.readers = {
      openMs: {
        pdfFirst: round(first.elapsed),
        epubFirst: round(second.elapsed),
        pdfResumedWarm: summary(warm.pdf),
        epubResumedWarm: summary(warm.epub),
      },
      turnMs: { pdf: summary(pdfTurns), epub: summary(epubTurns) },
      positionAcknowledgedMs: {
        pdf: summary(pdfSaves),
        epub: summary(epubSaves),
      },
      searchMs: {
        pdf: { common: pdfCommon, rare: pdfRare },
        epub: { common: epubCommon, rare: epubRare },
      },
      rendererExitMs: summary(exitTimes),
      processes: {
        pdf: { shell: first.pid, content: first.contentPid },
        epub: { shell: second.pid, content: second.contentPid },
        sharedContentRenderer: first.contentPid === second.contentPid,
      },
      bookFilesRead: read.length,
    };
    report.memory = {
      libraryIdle: idle,
      libraryRenderer: {
        idle: libraryIdle,
        allEntriesShown: libraryBrowsed,
        afterClosingReaders: libraryClosed,
        afterOpenCloseCycles: libraryCycled,
      },
      twoReadersOpened: opened,
      twoReadersAfterSearch: searched,
      afterClosingReaders: closed,
      afterOpenCloseCycles: cycled,
      libraryAllEntriesShown: browsed,
      cycleSeries: series,
    };
    for (const [name, results] of Object.entries({
      idle: queriesIdle,
      reading: queriesReading,
    }))
      for (const [query, result] of Object.entries(results))
        within(result.p95, budgets.catalogQueryP95Ms, `${name} ${query} p95`);
    for (const [name, value] of Object.entries({
      "PDF first open": first.elapsed,
      "EPUB first open": second.elapsed,
      "PDF resumed open": Math.max(...warm.pdf),
      "EPUB resumed open": Math.max(...warm.epub),
    }))
      within(value, budgets.readerOpenMaxMs, name);
    within(summary(pdfTurns).p95, budgets.pageTurnP95Ms, "PDF turn p95");
    within(summary(epubTurns).p95, budgets.pageTurnP95Ms, "EPUB turn p95");
    within(
      Math.max(...pdfSaves, ...epubSaves),
      budgets.positionAcknowledgedMaxMs,
      "position acknowledged",
    );
    for (const [name, result] of Object.entries({
      "PDF common": pdfCommon,
      "EPUB common": epubCommon,
    }))
      within(result.firstHitMs, budgets.firstSearchHitMs, `${name} first hit`);
    for (const result of [pdfCommon, pdfRare])
      within(result.totalMs, budgets.pdfFullSearchMs, "PDF full search");
    for (const result of [epubCommon, epubRare])
      within(result.totalMs, budgets.epubFullSearchMs, "EPUB full search");
    within(Math.max(...exitTimes), budgets.rendererExitMaxMs, "renderer exit");
    within(idle.totalPssMiB, budgets.libraryIdlePssMiB, "library idle PSS");
    within(searched.totalPssMiB, budgets.twoReadersPssMiB, "two readers PSS");
    within(
      closed.totalPssMiB - idle.totalPssMiB,
      budgets.closedReadersOverIdleMiB,
      "closed readers over idle",
    );
    within(
      Math.max(...series.map((sample) => sample.totalPssMiB)) -
        closed.totalPssMiB,
      budgets.openCloseCycleGrowthMiB,
      "open/close cycle growth",
    );
  } finally {
    await application.close();
  }
});
