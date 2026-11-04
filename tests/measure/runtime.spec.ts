import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Frame,
  type Page,
  test,
} from "@playwright/test";
import {
  COMMON_WORD,
  EPUB_OPENING,
  PDF_OPENING,
  RARE_WORD,
  type RepresentativeDocument,
  representativeEpub,
  representativePdf,
} from "./representative";

// Diagnostic measurements of the relocated packaged artifact with generated
// book-length documents. They calibrate budgets; they are not A13 (which
// needs the milestone-two 500-entry catalog).
const report: Record<string, unknown> = {};
let root: string;
let executablePath: string;
let pdf: RepresentativeDocument;
let epub: RepresentativeDocument;

// Budgets come from the recorded runs on the Arch desktop in
// docs/development.md (M1-07): roughly 2–3× the worst observation, so ordinary noise
// passes while a real regression (eager loading, a leaked renderer, blocking
// search) fails. Recalibrate from new evidence; do not loosen to get a pass.
// They cover generated diagnostic books, not the A13 500-entry catalog.
const budgets = {
  warmLaunchMedianMs: 1500,
  evictedLaunchMaxMs: 6000,
  firstRunLaunchMs: 8000,
  readerOpenMaxMs: 1500,
  pageTurnP95Ms: 300,
  firstSearchHitMs: 250,
  pdfFullSearchMs: 3500,
  epubFullSearchMs: 1000,
  rendererExitMaxMs: 1000,
  libraryIdlePssMiB: 400,
  twoReadersPssMiB: 800,
  closedReadersOverIdleMiB: 60,
  openCloseCycleGrowthMiB: 100,
};

test.beforeAll(async () => {
  // Relocate onto the same filesystem a personal install would use, not the
  // tmpfs default temp directory; dist/ is ignored by Git.
  await mkdir(resolve("dist"), { recursive: true });
  root = await mkdtemp(resolve("dist/measure-"));
  const artifact = join(root, "borges");
  await cp(resolve("dist/borges-runtime-check"), artifact, { recursive: true });
  executablePath = join(artifact, "borges");
  pdf = representativePdf();
  epub = representativeEpub();
  // Replace the allowlisted fixture bytes in the relocated copy, so the real
  // protocol handler serves them; the product gains no arbitrary-file loader.
  const fixtures = join(
    artifact,
    "resources/app/out/renderer/reader-assets/fixtures",
  );
  await writeFile(join(fixtures, "known.pdf"), pdf.bytes);
  await writeFile(join(fixtures, "reflowable.epub"), epub.bytes);
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

async function launch(profile: string) {
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
    },
  });
}

const round = (value: number) => Math.round(value * 10) / 10;
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

async function settle() {
  // Let GC/compositor work finish after an action before sampling memory.
  await new Promise((done) => setTimeout(done, 1500));
}

async function openReader(
  application: ElectronApplication,
  library: Page,
  bookId: "sample-pdf" | "sample-epub",
) {
  const started = performance.now();
  const [reader] = await Promise.all([
    application.waitForEvent("window"),
    library.evaluate((id) => window.development.openReader(id), bookId),
  ]);
  const ui = reader.frameLocator('iframe[title="Book content"]');
  await expect(ui.getByRole("status")).toHaveText("Ready", { timeout: 30_000 });
  if (bookId === "sample-pdf") {
    await expect(ui.getByTestId("page-text")).toContainText(PDF_OPENING);
  } else {
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
  const elapsed = performance.now() - started;
  // Shell renderer and the separate-origin content frame's renderer.
  const { pid, contentPid } = await application.evaluate(
    ({ BrowserWindow }, title) => {
      const contents = BrowserWindow.getAllWindows().find((window) =>
        window.getTitle().startsWith(title),
      )?.webContents;
      return {
        pid: contents?.getOSProcessId(),
        contentPid: contents?.mainFrame.frames.find((frame) =>
          frame.url.startsWith("borges://reader/"),
        )?.osProcessId,
      };
    },
    bookId === "sample-pdf" ? "Sample PDF" : "Sample EPUB",
  );
  return { reader, ui, elapsed, pid, contentPid };
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

/** Drop the artifact's and profile's clean pages from the page cache. Shared
 * system libraries stay cached, so this is a partial cold start. */
async function evict() {
  run("sync", ["-f", root]);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries)
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

test("first, repeated, and evicted-cache packaged launches", async () => {
  const profile = await mkdtemp(join(root, "launch-profile-"));
  const launches: number[] = [];
  const evicted: number[] = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    const cold = attempt >= 6;
    if (cold) await evict();
    const started = performance.now();
    const application = await launch(profile);
    try {
      const library = await application.firstWindow();
      await expect(library.getByTestId("launch-count")).toHaveText(
        String(attempt + 1),
        { timeout: 30_000 },
      );
      (cold ? evicted : launches).push(performance.now() - started);
    } finally {
      await application.close();
    }
  }
  report.launchMs = {
    firstRunFreshProfile: round(launches[0] ?? 0),
    repeatedWarm: summary(launches.slice(1)),
    evictedArtifactAndProfile: summary(evicted),
    note: "Wall time from launch to the library's committed launch count, including Playwright launch/CDP attach. Eviction uses POSIX_FADV_DONTNEED on artifact/profile files; system libraries remain cached.",
  };
  const within = (value: number, budget: number, name: string) =>
    expect.soft(value, `${name} ≤ ${budget}`).toBeLessThanOrEqual(budget);
  within(
    summary(launches.slice(1)).median,
    budgets.warmLaunchMedianMs,
    "warm launch median",
  );
  within(Math.max(...evicted), budgets.evictedLaunchMaxMs, "evicted launch");
  within(launches[0] ?? Infinity, budgets.firstRunLaunchMs, "first-run launch");
});

test("two representative readers: open, page turns, search, memory and disposal", async () => {
  const profile = await mkdtemp(join(root, "reader-profile-"));
  const application = await launch(profile);
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
    await expect(library.getByTestId("launch-count")).toHaveText("1");
    await settle();
    const idle = await memory(application);

    const first = await openReader(application, library, "sample-pdf");
    const second = await openReader(application, library, "sample-epub");
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

    const pdfCommon = await search(first.ui, COMMON_WORD, pdf.commonCount);
    const pdfRare = await search(first.ui, RARE_WORD, 1);
    await first.ui.locator("#results button").first().click();
    await expect(first.ui.locator("#location")).toHaveText(
      `Page ${pdf.rareLocation} of ${pdf.units}`,
    );
    const epubCommon = await search(second.ui, COMMON_WORD, epub.commonCount);
    const epubRare = await search(second.ui, RARE_WORD, 1);
    await second.ui.locator("#results button").first().click();
    await expect(second.ui.locator("#location")).toHaveText(
      new RegExp(`^Chapter ${epub.rareLocation} · \\d+%$`),
    );
    await settle();
    const searched = await memory(application);

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
    await settle();
    const closed = await memory(application);

    // Repeated open/close cycles: warm open times and growth after disposal.
    const warm = { pdf: [] as number[], epub: [] as number[] };
    const cycles = Number(process.env.BORGES_MEASURE_CYCLES ?? 5);
    const series: {
      totalPssMiB: number;
      browserPssMiB: number;
      mainHeapMiB: number;
    }[] = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      const a = await openReader(application, library, "sample-pdf");
      const b = await openReader(application, library, "sample-epub");
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
    const windows = await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    expect(windows).toBe(1);

    report.readers = {
      openMs: {
        pdfFirst: round(first.elapsed),
        epubFirst: round(second.elapsed),
        pdfWarm: summary(warm.pdf),
        epubWarm: summary(warm.epub),
      },
      turnMs: { pdf: summary(pdfTurns), epub: summary(epubTurns) },
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
    };
    report.memory = {
      libraryIdle: idle,
      twoReadersOpened: opened,
      twoReadersAfterSearch: searched,
      afterClosingReaders: closed,
      afterOpenCloseCycles: cycled,
      cycleSeries: series,
    };
    const within = (value: number, budget: number, name: string) =>
      expect.soft(value, `${name} ≤ ${budget}`).toBeLessThanOrEqual(budget);
    for (const [name, value] of Object.entries({
      "PDF first open": first.elapsed,
      "EPUB first open": second.elapsed,
      "PDF warm open": Math.max(...warm.pdf),
      "EPUB warm open": Math.max(...warm.epub),
    }))
      within(value, budgets.readerOpenMaxMs, name);
    within(summary(pdfTurns).p95, budgets.pageTurnP95Ms, "PDF turn p95");
    within(summary(epubTurns).p95, budgets.pageTurnP95Ms, "EPUB turn p95");
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
