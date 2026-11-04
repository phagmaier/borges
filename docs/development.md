# Development setup

The development environment is installed on the user's Arch Linux/Hyprland desktop. The diagnostic Electron shell opens one library and named readers with bundled known PDF/EPUB fixtures. Engine navigation/search/sizing, explicit snapshot restoration, diagnostic adversarial isolation, packaged-runtime SQLite/schema handling, and diagnostic packaged resource measurements are verified; catalog-backed session checks, autosave, catalog/500-entry measurements, and the rest of the integration spike remain pending. It does not open/change user book files and uses a separate `borges-development` Electron profile. Existing-window focus is an outstanding desktop integration failure; see [M1-02 evidence](#multi-window-spike-m1-02).

## Start working

From this directory:

```sh
mise run dev
```

This first builds the isolated reader and its bundled assets, then starts the main/preload builds, local Vite server, and Electron window. Trusted shell React/CSS edits hot reload; reader adapter/content changes require restarting `pnpm dev` to rebuild the isolated content bundle; main/preload changes can be watched with `pnpm dev --watch` through mise. Closing the last application window stops the development process. The local server and React-refresh CSP relaxation are development-only; the built app uses local assets and a strict CSP.

Use **Open Sample PDF** and **Open Sample EPUB** to exercise separate reader shells. These diagnostic IDs load known fixtures. The extra Image-only PDF, Fixed EPUB, and Obfuscated-font EPUB entries exercise the other fixture variants. Reopening reuses the existing window and requests focus. Readers offer **Open library**; closing the library leaves readers running. The last window exits, or **Quit application** closes all windows. A second launch with the same development profile routes to the existing instance. Closing the library alone stops development only when no readers remain.

```sh
mise run check
mise run smoke
mise run smoke-packaged
mise run measure
```

`check` runs TypeScript, Biome lint/format checks, Vitest, and the production build. `smoke` builds and launches real Electron on the available desktop display. Playwright uses the installed Electron executable; no separate Playwright Chromium download is needed. Headless CI display setup is future work and is not needed on this desktop. `smoke-packaged` separately builds a bundled Electron directory and tests a relocated copy. `measure` builds that directory and records launch, reader, search, memory and disposal measurements against budgets; see [M1-07](#packaged-runtimeresource-measurements-m1-07). Run the native suites serially on this desktop; concurrent GUI runs can interfere with input/focus and have exhibited reader-opening timeouts.

Other commands, using `mise exec -- pnpm …` if the shell's mise hook is inactive:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Development app with React/CSS hot reload |
| `pnpm dev --watch` | Also rebuild/restart for main/preload changes |
| `pnpm build` | Compile main, sandboxed preload, and renderer into `out/` |
| `pnpm package:runtime` | Build the minimal Linux diagnostic artifact in `dist/borges-runtime-check/` |
| `pnpm test:packaged` | Build that artifact and verify relocated execution, SQLite restart persistence, and schema refusal |
| `pnpm measure:runtime` | Build that artifact and record packaged measurements in `dist/measurements/latest.json` |
| `pnpm start` | Run the built diagnostic shell |
| `pnpm typecheck` | Strict TypeScript checks |
| `pnpm lint` | Biome lint/format checks |
| `pnpm format` | Apply formatting and safe lint fixes to project code/config |
| `pnpm test` / `pnpm test:watch` | Resource-boundary tests once / in watch mode |
| `pnpm test:e2e` | Build and run native reader, restart, startup/SQLite, and window checks; focus currently fails on this desktop |

## Reproduce the installation

For another checkout or after removing installed dependencies:

```sh
mise trust
mise install node pnpm
mise run setup
```

`setup` initializes the pinned Git submodule, installs from `pnpm-lock.yaml` with the lockfile enforced, and downloads/verifies the Electron binary. Build/install requires network access for uncached dependencies; the built shell uses no remote service. Use `git clone --recurse-submodules` when cloning, or let `setup` initialize the submodule.

Do not run an install inside `vendor/foliate-js`; its source/vendor assets are already present, and its unrelated upstream development toolchain is not needed. Keep updates deliberate and record the reviewed Git commit.

## Installed versions and dependencies

| Component | Pin / observed runtime |
| --- | --- |
| Development Node | 26.13.0, pinned through mise |
| pnpm | 12.16.1, pinned through mise and packageManager |
| Electron | 45.2.1 |
| Electron's embedded Node | 24.22.1, distinct from development Node |
| Embedded SQLite | 3.53.4, accessed through `node:sqlite` |
| React / React DOM | 19.3.1 |
| TypeScript | 7.0.2; Node types target Electron's Node 24 API |
| Vite / electron-vite | 8.3.5 / 6.0.0 |
| Biome / Vitest / Playwright | 2.6.4 / 5.0.5 / 1.64.1 |
| PDF.js | `pdfjs-dist` 6.5.438, initial adapter rendering verified |
| foliate-js | Git submodule `78914aef4466eb960965702401634c2cb348e9b1`, initial adapter rendering verified |

The existing mise installations were reused. No Rust, Python environment, separate SQLite driver/server, or globally installed JavaScript tooling is required for this setup. `uv` remains available for future Python-only helper work if needed; there is no Python project here.

All Electron dynamic-library requirements resolved on this machine. Existing packages include GTK3, NSS, libcups, ALSA, X11 libraries, Mesa/libdrm, libxkbcommon, and accessibility libraries; no pacman installation was needed. Git and base-devel are also already installed. The tests ran in the current Hyprland Wayland session with a display available; this is not a claim of coverage for every graphics backend or scaling configuration.

## Dependency policy and provenance

Exact direct dependency versions are in `package.json`; transitive versions/integrities are locked. `pnpm-workspace.yaml` explicitly enforces the 1440-minute release gate, including strict failure rather than age fallback, and requires a named decision for dependency build scripts. No age exclusions are configured. Vitest 5.0.5 was selected because the newer 5.1.0 had not yet cleared that gate at setup time.

pnpm 12's `allowBuilds` replaces the legacy `onlyBuiltDependencies` setting named in the shared instructions. Only Electron is allowed; unknown build scripts fail installation. Do not add the ignored legacy key or disable the gate globally. [pnpm build settings](https://pnpm.io/settings/build), [release-age settings](https://pnpm.io/settings/dependency-resolution)

foliate-js is pinned as a Git submodule, retaining its MIT license and bundled dependency notices. PDF.js includes its upstream license/notices in the installed distribution. No Calibre code has been copied. Review actual packaged dependency/asset notices before distribution; the project's eventual public license is not decided by this private development scaffold.

## Verification performed

- `mise install node pnpm`: pinned development tools available.
- Locked pnpm installation and explicit Electron binary download.
- Electron executable's dynamic-library resolution: no missing libraries.
- `pnpm check`: strict type checking, recommended Biome checks, 13 resource-boundary cases, and a production build.
- Native Playwright smoke: built local window renders; runtime SQLite version is available; preload reports sandbox/context isolation; page has no Node require; production CSP excludes unsafe-inline/eval; shell reload works; a known value persists after closing/reopening a real SQLite file in Electron's embedded Node.
- Live development check: temporary CSS and exported React-component edits hot reload without replacing the document; sources were restored and the test app was closed.

These setup checks validate the scaffold/toolchain, not PDF/EPUB rendering, library data recovery, complete content isolation for books, full multi-reader behavior, packaging, or performance on 500 books. Continue the remaining [milestone-one spike](implementation-plan.md) for those checks. Smoke-test profiles/databases are temporary and cleaned up; build/test artifacts are ignored by Git.

## Multi-window spike (M1-02)

Implemented and reviewed on 2026-11-03 without dependency changes. `mise run check` passes: strict types, Biome, 13 resource-boundary cases, and the built local application. `mise run smoke` runs six native cases: five pass and the existing-reader focus case fails. The test remains enabled, so `smoke` currently exits unsuccessfully.

Passing evidence covers the startup/SQLite baseline; concurrent duplicate reader requests; separate sandboxed reader shells with distinct native titles; identity retained on reload; library close/reopen; reader close/reopen; last-window exit; explicit Quit; a real second process routed to the first instance; failed navigation cleanup and successful retry; unknown book rejection; reader-to-library impersonation rejection; and rejection of an unregistered window using the real preload/IPC. This is trusted-shell validation, not proof of book-content isolation or stale progress rejection.

Focus failure: the native test waits for the first reader to gain focus, opens the second reader and observes the first lose focus, then reopens the first and waits for `BrowserWindow.isFocused()` to become true. That last assertion fails. Reproduced with the default launch and with `--ozone-platform=x11`; neither is accepted as a workaround. `hyprctl -i 0 -j getoption misc:focus_on_activate` reports false. A direct XWayland probe also showed focus remaining on the second reader after the first reader's `focus()` call. This is consistent with [Hyprland's activation policy](https://wiki.hypr.land/Configuring/Basics/Variables/) and [Electron's compositor-dependent focus support](https://www.electronjs.org/docs/latest/api/browser-window). Desktop settings have not been changed. A scoped activation allowance or another supported mechanism still needs validation before M1-02 is done.

Observed session: Arch/Hyprland, Wayland session with XWayland available, Samsung C32F391 on HDMI-A-1 at 1920×1080 and scale 1. This is one display configuration, not coverage of other scaling/backends. The shell's profile lock is not the future exclusive library-root lock. No progress persistence, reader rendering, packaged distribution, or resource/performance budget is claimed.

## Format-adapter spike (M1-03)

Implemented and directly reviewed on 2026-11-03 without dependency/pin changes. `mise run check` passes strict types, Biome, 23 resource-path unit cases, and the production build. Six native reader cases pass; the full smoke suite has 11 passing cases and the unchanged M1-02 existing-reader focus failure. Native screenshot inspection confirms the reflowable chapter's text and coral image in the diagnostic window.

`src/readers` contains an initial open/dispose contract, PDF.js canvas adapter, and a foliate adapter containing its unstable API surface. PDF.js uses its matching bundled worker and local font/CMap/WASM directories; this initial canvas path uses JavaScript decoders (`useWasm: false`). EPUB uses the pinned ZIP loader, EPUB parser, view, and paginator/fixed-layout renderer. Only these integration paths were inspected; unrelated foliate format engines are not validated. Upstream source and dependency notices are copied unchanged from the submodule; its license and bundled notices remain with the generated assets. Update only by deliberately reviewing/changing the Git submodule pin and rerunning these checks. [PDF.js document parameters](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) document its local resource options.

The trusted shell embeds `borges://reader/content.html` on a distinct origin with no preload bridge. Its CSP allows local engine scripts, blob frames/images/fonts, and inline styles required by foliate/publisher layout; JavaScript eval and inline scripts remain disallowed. The foliate transform hook blocks script assets, strips active markup, and adds a script-denying book-document CSP. Native tests establish absence of the application bridge and denied access to the parent bridge; they do **not** establish the complete malicious-content boundary. Only allowlisted created fixtures are exposed in the diagnostic UI. M1-05 must test remote resources, path escapes, scripts/navigation/windows and forged/stale messages before arbitrary imports.

See [fixture provenance](../tests/fixtures/README.md) and its standard-library generator. Tests use independent first-page text markers, decoded coral PDF pixels, EPUB image visibility/dimensions, one loaded chapter frame (including a publisher-requested fixed spread), and actual loaded deobfuscated font. A deliberately corrupt PDF reports an error while another EPUB reader still opens. Assets are copied locally into ignored `.reader-assets/` and then `out/renderer/`; no runtime CDN or development server supplies book assets.

Scope is initial rendering/disposal. PDF shows its first physical page and a diagnostic text transcript; EPUB shows its first chapter/page in single-page mode. Keyboard navigation, search/jumps, resize-aware PDF fitting, zoom/pan, stable locations, persisted settings/progress, representative protected/corrupt documents, packaged delivery and performance remain unverified or unimplemented. Next: M1-04 navigation/search/sizing/resume. M1-02's compositor focus gate remains enabled and unresolved.

## Reader interaction and locator spike (M1-04)

Implemented and directly reviewed on 2026-11-03 with the same dependency and foliate pins. `mise run check` passes types, Biome, 36 unit cases, and the production build. The full `mise run smoke` has 18 passing native cases and the unchanged M1-02 existing-reader focus failure. Seven new native scenarios cover the reader interaction/locator gate, including actual Electron shutdown/relaunch for both formats. Native-window screenshot inspection confirms visible PDF text and the coral image beneath the controls; text-layer selection and search ranges use the bundled PDF.js styles.

Both adapters expose navigation, capture/restore, sizing, contents, incremental cancellable text search, temporary selection/highlighting, and disposal through `ReaderSession`; engine objects remain private. The content origin still has no host bridge. Arrow keys, `/`, and `:` act on the reading surface and EPUB document; inputs/buttons retain editing behavior. Jump validation does not move on failure. Explicit button/Enter handling avoids form submission, which is intentionally unavailable in the sandbox. PDFs use physical pages and outline/internal-link destinations; EPUBs use chapter/percentage navigation, one column or one fixed page, and CFI anchors.

Use visible Previous/Next, Search, Jump, Contents, font-size or zoom controls. Search produces incremental results, Enter/Shift+Enter traverses them, and Esc closes it and restores surface focus. Image-only PDFs report text unavailable; text books with no hits report no matches. Search query generations discard stale work, including queued selections; closing search still completes a selected navigation while removing its temporary highlighting. Literal Unicode matching keeps offsets in original text, avoiding shifted matches after characters whose lowercase representation expands.

Open **Diagnostic location snapshot** to capture the current location/sizing, copy its JSON, and restore it explicitly. Snapshots include SHA-256 of the exact fixture bytes, versioned shape, PDF page/normalized pan or EPUB CFI/chapter/fraction, and font/zoom settings. Restore rejects malformed or foreign-revision data. EPUB CFI restoration validates the chapter/anchor; an unusable CFI falls back to chapter/fraction with an approximate notice. PDF pages outside the document restart at the beginning with a notice. Explicit content targets remain stable through font/viewport changes and reset on page turns.

This is the engine restoration gate, **not automatic library persistence**. Restart tests export a snapshot through the diagnostic UI, write it to a temporary file in the test harness, terminate Electron, launch a fresh process, and paste the snapshot back through the UI. The app itself neither writes progress nor automatically resumes. No localStorage, arbitrary host bridge, or privileged persistence API was added. Central revision/session generations, monotonic acknowledged saves, one-second autosave and close/Quit flushing still require the isolation gate and real catalog/session implementation in milestones 2/5. Per-book sizing is represented in the exported snapshot, not yet durably stored by the application.

Independent oracles include ORCHID/CEDAR/HARBOR physical PDF pages, outline/link destinations created in the fixture, distinct repeated match offsets, EPUB markers and actual selected/visible text ranges, native wheel pan with one physical page/chapter, and LANTERN PASSAGE 24 after font change, viewport change and process restart. The longer reflowable fixture contains 40 numbered passages so repagination cannot pass by showing an unchanged one-page book. A failing native regression established the original anchor-loss problem before its correction. A corrupt/foreign snapshot has explicit failure/fallback checks; these tests do not establish library recovery or the full A5–A7/A14 acceptance criteria.

Remaining gates: M1-05 adversarial content/resource serving and forged/stale sessions; production autosave/catalog/root lock; arbitrary EPUB/PDF corpus exceptions and protected-file reasons; packaged offline execution and measured resource/performance budgets. Rich PDF named/XYZ destinations currently resolve to the physical destination page, not exact destination pan. The renderer controls and diagnostic layout remain provisional.


## Adversarial reader/resource isolation (M1-05)

Implemented and directly reviewed on 2026-11-03 with unchanged dependency pins and no new privileged bridge. `mise run check` passes types, Biome, 39 unit cases, and the production build. Full `mise run smoke` has 23 passing native cases and the unchanged M1-02 existing-reader focus failure. Five new isolation scenarios pass in the real Electron runtime; ordinary PDF/EPUB rendering, navigation, local fonts/images, and process-restart restoration also pass.

The `borges` handler now decodes/normalizes paths before checking reader asset scope, resolves real filesystem paths under the canonical renderer root, rejects directories and escaping file/directory symlinks, and rechecks reader scope after canonicalization. A symlink into the privileged shell is also denied from the reader origin. Native tests exercise the actual protocol and assert denied responses contain no host bytes. Unit tests retain positive local-file/contained-alias controls. EPUB resources are read from an in-memory ZIP-entry map, without extracting publisher paths to the host filesystem. The current serving scope is the diagnostic bundle; future catalog imports still need approved revision/cover grants. Canonical path checks assume application-owned files are not concurrently mutated by another host process; this is not protection against an attacker already controlling the installation directory.

The coordinator now validates all frame navigations, including the assigned engine URL and the engine's creation of chapter blobs. Book frames cannot replace the engine or navigate an ancestor into another role. The native reassignment regression failed before this fix. Window creation remains denied. Both permission checks and permission requests now deny access: before adding the check handler, a real `navigator.permissions.query` probe reported geolocation as granted. [Electron frame-navigation events](https://www.electronjs.org/docs/latest/api/web-contents#event-will-frame-navigate) and [session permission handlers](https://www.electronjs.org/docs/latest/api/session#sessetpermissioncheckhandlerhandler) describe these distinct boundaries.

The created malicious EPUB contains inline/manifest/remote scripts, inline and external SVG, event attributes, embedded frames/objects, remote assets/connection hints, traversal/file URLs, refresh/base elements, links and a form. Native input tests confirm no script sentinel, document replacement, or additional window; known local coral pixels/dimensions and the obfuscated font remain usable. Connection hints are removed before serialization, and JavaScript URL detection accounts for embedded ASCII controls. A real local HTTP endpoint receives a separate test-harness control request, while Electron session fetches and chapter image/CSS/font/fetch attempts are denied without reaching it. No network endpoint or unsafe runtime flag was added to the application.

Review found that removing active DOM nodes shifted CFI search offsets relative to the original document. A failing native regression now verifies selection of REMOTE RESOURCE PROBE after sanitization; search and locator validation use the same sanitized structure as the rendered chapter. Full-suite testing also reproduced a queued-resize race that cleared a selected search hit. Repagination now restores the active selection while explicit navigation/search dismissal still clears it. The existing interaction test was extended with font/viewport changes and dismissal; it failed before the correction and passes afterward. Temporary tracing was removed.

Forged book/revision/generation/sequence payloads and window commands sent through `postMessage`, including replay attempts after reader close/reopen, have no receiving authority. Actual book frames have neither preload bridge, Node require, nor IPC access; attempts leave both EPUB and PDF positions unchanged. **There is no production progress endpoint or catalog write in this spike.** These tests establish the current diagnostic boundary, not real stale-token/monotonic-write rejection. Milestones 2/5 must verify that contract against central storage before adding a save bridge. Arbitrary-import grants, save/close flushing, packaged-runtime isolation and a broader hostile/corrupt corpus remain downstream. Full A14 and milestone one are not claimed complete.


## Packaged-runtime SQLite gate (M1-06)

Implemented and directly reviewed on 2026-11-03 without dependency changes. `mise run check` passes strict types, Biome (including the packaging script), all 44 unit cases, and the production build. `mise run smoke-packaged` passes three native packaged-runtime cases. A serial full `mise run smoke` has 23 passing cases and the unchanged M1-02 existing-reader focus failure. An earlier concurrent run of the two native suites also timed out opening a fixed EPUB and a packaged reader; these timeouts did not recur in the separate runs. Their cause is not established; no reader assertion was relaxed and no reader implementation was changed by this task.

The selected binding remains **Electron's built-in `node:sqlite`**: the relocated executable reports Electron 45.2.1, embedded Node 24.22.1 and SQLite 3.53.4. No native addon, rebuild step, additional runtime dependency, or development server is needed. The minimal packaging script copies the installed, pinned Linux Electron distribution and built application into the documented [Electron `resources/app` layout](https://www.electronjs.org/docs/latest/tutorial/application-distribution#with-prebuilt-binaries). It preserves Electron/Chromium notices, the copied PDF.js/foliate/fixture notices, and adds React/React DOM/scheduler licenses. The resulting diagnostic directory is about 306 MiB on this filesystem; this is an observed artifact size, not a resource budget or complete personal release.

```sh
mise exec -- pnpm package:runtime
BORGES_DEV_PROFILE=/tmp/borges-runtime-profile ./dist/borges-runtime-check/borges
mise run smoke-packaged
```

Keep the whole directory together when relocating it. Native Arch shared libraries/display access are still required. Packaging uses only installed dependencies and built assets; the command rebuilds first. The packaged application ignores `ELECTRON_RENDERER_URL`, including a deliberately invalid loopback value in the test, and loads `borges://app/index.html` locally. Tests copy the complete artifact outside the checkout, use an empty working directory and a system-only PATH, and confirm `app.isPackaged`, app path and executable path. They verify known PDF and EPUB text with both readers open, plus the EPUB's local coral image. This is a packaging sanity check; it does not replace the full adversarial suite or establish performance on a varied corpus.

Startup now commits one launch counter in `runtime-check.sqlite` inside the diagnostic Electron profile. The existing validated runtime-info bridge exposes a read-only result; reloads and runtime-info calls do not write or increment the counter. The default remains the separate `borges-development` profile; `BORGES_DEV_PROFILE` can isolate a run. This is **not the library catalog**, its identity/schema, or reader progress. No user book or production library path is opened. The schema initializes only an empty, version-zero database; schema and initial row are created transactionally, and subsequent launches retain the existing marker while incrementing the committed count.

The packaged persistence test shuts down Electron, independently reads its committed row and supplies a Unicode marker, then launches a fresh process with the same profile. The second process reads that marker and commits count two. Packaged startup refuses a future schema and a damaged supported schema with exit code 1 and a stderr diagnostic; both files remain byte-for-byte unchanged. Unit tests additionally cover a populated unversioned database, a missing probe row, and a real SQLite trigger failure after a row update: rollback preserves count one and retry commits count two. The initial four focused storage tests failed before implementation; the packaged development-URL regression also failed before its fix.

Review covered the new database module, startup/diagnostic wiring, packaging script/configuration, existing startup test, new unit/native cases, and affected documents, including untracked files. No unresolved in-scope finding remains. Production catalog migrations (including consistent snapshots before destructive changes and failure recovery), root locking, filesystem publication/reconciliation, acknowledged autosave/session validation, full packaged security checks, measured performance/disposal budgets, and final launchers/desktop integration remain required in their planned tasks. No destructive schema migration or full A12/A13/A14 acceptance is claimed. M1-02 still blocks milestone-one completion.


## Packaged runtime/resource measurements (M1-07)

Implemented and reviewed on 2026-11-03 with no dependency or product-code changes. `mise run measure` packages the diagnostic artifact, copies it to `dist/measure-*` on the home filesystem (not tmpfs), replaces the two allowlisted fixture files *in that copy* with generated book-length documents, runs two serial native suites, writes `dist/measurements/latest.json` (path overridable with `BORGES_MEASURE_REPORT`), and deletes the copy. The application gains no file loader. `mise run check` still passes with 44 unit cases. The measurement suite is separate from `smoke` because its timing budgets are machine-specific.

Session: Intel Core i5-9400 (6 cores, `powersave` governor, 4.1 GHz max), 11.5 GiB RAM, Intel UHD Graphics 630 with GPU compositing/OpenGL/rasterization enabled, Arch kernel 7.2.14, Hyprland 0.57.0 Wayland session (Electron's default backend selection; not separately verified), one 1920×1080 display at scale 1. `/home` is btrfs on a 7200 rpm WD10EZEX hard disk, and `/tmp` is tmpfs. Electron is 45.2.1 (Node 24.22.1).

Generated documents (`tests/measure/representative.ts`, deterministic and created; no third-party text): a 400-page Letter PDF with about 211k words, 16 full-colour 480×320 images and Flate streams (2.3 MB); and a 40-chapter EPUB with 120k words and eight 800×600 PNG illustrations (1.1 MB). The generator's counts are the oracle: 1,420 PDF and 796 EPUB occurrences of “lantern”, plus a single rare word on PDF page 397 and in EPUB chapter 38. Poppler `pdftotext`/`pdfinfo` and `unzip` independently agree with those counts and with the page total. The suite also checks the opening headings, distinct visible text after every page turn, PDF page labels and heading 21, and navigation to the rare hit.

Results from eight full runs, including a 20-cycle exploratory run and the deliberate gate-failure check; the last is the recorded report. Times are wall time and include Playwright's launch/CDP and polling overhead, so they are upper bounds:

| Measure | Observed | Budget |
| --- | --- | --- |
| Launch to committed library state, warm, median of 5 | 0.52–0.59 s (one outlier max 1.0 s) | ≤ 1.5 s |
| Launch with artifact/profile evicted from page cache, max of 3 | 2.6–2.8 s | ≤ 6 s |
| First launch, fresh profile | 3.0–3.8 s | ≤ 8 s |
| Reader open to opening text, first or warm (both formats) | 0.27–0.57 s | ≤ 1.5 s |
| Page turn p95, PDF / EPUB (20 turns) | 60–129 ms / 103–113 ms | ≤ 300 ms |
| First search hit | ≤ 53 ms | ≤ 250 ms |
| Full PDF search, 400 pages (common word / rare word) | 1.36–1.40 s / 0.85–0.88 s | ≤ 3.5 s |
| Full EPUB search, 40 chapters (common word / rare word) | 0.23–0.26 s / 0.11–0.15 s | ≤ 1 s |
| Closed reader renderer exits | ≤ 95 ms | ≤ 1 s |
| Total PSS: library idle | 238–242 MiB | ≤ 400 MiB |
| Total PSS: two readers after both searches | 481–497 MiB (381–404 MiB before search) | ≤ 800 MiB |
| PSS after closing readers, above idle | 14–17 MiB | ≤ 60 MiB |
| PSS growth over 5 two-reader open/close cycles | 24–29 MiB | ≤ 100 MiB |

Budgets are about 2–3× the worst observation and use soft assertions, so every violation is reported. A deliberately impossible turn budget made the suite fail as expected; the budget was then restored. The suite covers generated diagnostic books on this one machine. It is **not A13**: catalog search and the 500-entry catalog need milestone two's catalog and must be measured then. The budgets should be recalibrated from evidence, never loosened to get a pass.

Memory is the sum of kernel PSS (`/proc/<pid>/smaps_rollup`) over Electron's `getAppMetrics()` processes. RSS is also recorded but double-counts shared pages. Findings:

- **Content renderers are shared across readers.** Each reader shell has its own renderer, but both books' `borges://reader` content frames ran in one renderer process in every run (`sharedContentRenderer: true`). That process grew from 104–122 MiB to about 200 MiB after the two searches. It exits only when the last reader closes; the suite asserts that it does. Each book remains a separate window/frame tree without a host bridge. The consequence is crash and memory containment: one book's renderer crash or memory growth affects the other reader. Give each reader a distinct content origin if milestone five's crash-containment checks require separation; this task did not change the reader origin.
- **Closing readers releases renderers.** Shell and content processes leave the metrics within 100 ms, and the window count returns to the library only.
- **Main-process growth is reclaimable, not an observed leak.** The main (Browser) process gains about 5 MiB of native memory per two-reader open/close cycle while its JS heap stays at 5–8 MiB. A throwaway uninstrumented probe (a scratch copy of the artifact cycling readers from main, without Playwright) showed the same slope and a drop back near baseline at cycle 16. The Playwright 20-cycle run dropped at cycle 7. The cause (for example deferred native-object finalization) is not established. A long session with many opens has not been tested beyond 20 cycles.
- **The PDF search scan is the slowest interaction.** A 400-page scan takes about 0.85 s before the last-page hit, and building 1,420 result rows adds about 0.5 s. Results arrive incrementally, so the first row appears within 53 ms. Very large PDFs scale linearly; milestone five's incremental-search work should keep cancellation and row rendering bounded.

Limitations: cache eviction uses `dd iflag=nocache` (POSIX_FADV_DONTNEED) after `sync`. It evicts only the artifact/profile files, and `fincore` confirms the executable has no resident pages. System libraries stay cached, so this is a partial cold start, not a post-boot measurement. Dropping the whole cache needs root and was not done. No other display scale, backend, multi-monitor setup or GPU was measured. Book bytes are served from the artifact rather than the future library root.
