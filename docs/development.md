# Development setup

The development environment is installed on the user's Arch Linux/Hyprland desktop. The diagnostic Electron shell opens one library and named readers with bundled known PDF/EPUB fixtures. Engine navigation/search/sizing, explicit snapshot restoration, diagnostic adversarial isolation, packaged-runtime SQLite/schema handling, catalog readers with central autosave, packaged resource measurements with a 500-entry catalog (A13), and the library window (browsing, search/filters, sections and memberships, status/Archive actions and metadata editing; M3-01 to M3-04) are verified. Covers, startup problems in a window, visual prototypes and milestones four to six remain pending. It does not open/change user book files and uses a separate `borges-development` Electron profile. Its versioned, locked library catalog lives in `<profile>/library` for unpackaged builds; see [M2-01](#catalog-schema-migrations-and-root-lock-m2-01). Reopening an existing reader requests activation; this Hyprland policy answers with an urgency hint rather than focus, a recorded platform limit; see [M1-02 evidence](#multi-window-spike-m1-02).

## Start working

From this directory:

```sh
mise run dev
```

This first builds the isolated reader and its bundled assets, then starts the main/preload builds, local Vite server, and Electron window. Trusted shell React/CSS edits hot reload; reader adapter/content changes require restarting `pnpm dev` to rebuild the isolated content bundle; main/preload changes can be watched with `pnpm dev --watch` through mise. Closing the last application window stops the development process. The local server and React-refresh CSP relaxation are development-only; the built app uses local assets and a strict CSP.

The library window opens at All Books over the development catalog in `<profile>/library`. It starts empty: until import arrives in milestone four, books can be added only by the tests or, while the app is closed, with `mise exec -- node tests/unit/storage-child.ts add-books ~/.config/borges-development/library <files…>` (the default development profile). Its Development footer keeps the diagnostic fixture readers, Quit and runtime diagnostics. Use **Open Sample PDF** and **Open Sample EPUB** to exercise separate reader shells. These diagnostic IDs load known fixtures. The extra Image-only PDF, Fixed EPUB, and Obfuscated-font EPUB entries exercise the other fixture variants. Reopening reuses the existing window and requests focus. Readers offer **Open library**; closing the library leaves readers running. The last window exits, or **Quit application** closes all windows. A second launch with the same development profile routes to the existing instance. Closing the library alone stops development only when no readers remain.

```sh
mise run check
mise run smoke
mise run smoke-packaged
mise run measure
```

`check` runs TypeScript, Biome lint/format checks, Vitest, and the production build. `smoke` builds and launches real Electron on the available desktop display. Playwright uses the installed Electron executable; no separate Playwright Chromium download is needed. Headless CI display setup is future work and is not needed on this desktop. `smoke-packaged` separately builds a bundled Electron directory and tests a relocated copy. `measure` builds that directory, seeds a representative 500-entry catalog (about 2.5 minutes on the HDD), and records launch, catalog query, reader, save, search, memory and disposal measurements against budgets; see [A13](#a13-500-entry-catalog-measurements) and [M1-07](#packaged-runtimeresource-measurements-m1-07). Run the native suites serially on this desktop; concurrent GUI runs can interfere with input/focus and have exhibited reader-opening timeouts.

Other commands, using `mise exec -- pnpm …` if the shell's mise hook is inactive:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Development app with React/CSS hot reload |
| `pnpm dev --watch` | Also rebuild/restart for main/preload changes |
| `pnpm build` | Compile main, sandboxed preload, and renderer into `out/` |
| `pnpm package:runtime` | Build the minimal Linux diagnostic artifact in `dist/borges-runtime-check/` |
| `pnpm test:packaged` | Build that artifact and verify relocated execution, catalog restarts/relocation, root-lock conflict/recovery, and catalog refusals |
| `pnpm measure:runtime` | Build that artifact and record packaged measurements in `dist/measurements/latest.json` |
| `node scripts/build-measure-catalog.ts <new root>` | Build the 500-entry measurement library once, for `BORGES_MEASURE_CATALOG` iteration (run through `mise exec --`) |
| `pnpm start` | Run the built diagnostic shell |
| `pnpm typecheck` | Strict TypeScript checks |
| `pnpm lint` | Biome lint/format checks |
| `pnpm format` | Apply formatting and safe lint fixes to project code/config |
| `pnpm test` / `pnpm test:watch` | Resource-boundary tests once / in watch mode |
| `pnpm test:e2e` | Build and run native reader, restart, startup/SQLite, and window checks |

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

Original focus failure: the native test waited for the first reader to gain focus, opened the second reader and observed the first lose focus, then reopened the first and waited for `BrowserWindow.isFocused()` to become true. That last assertion failed with the default launch and with `--ozone-platform=x11`. `hyprctl -i 0 -j getoption misc:focus_on_activate` reports false. The earlier note that this was consistent with [Hyprland's activation policy](https://wiki.hypr.land/Configuring/Basics/Variables/) and [Electron's compositor-dependent focus support](https://www.electronjs.org/docs/latest/api/browser-window) is now confirmed directly.

**Native-Wayland/xdg-activation investigation (2026-11-03).** A correction to the earlier record: the default launch was already **native Wayland, not XWayland**. Hyprland's client list reports `xwayland: false` for every Borges window, and Electron's `ozone-platform` switch reads `wayland` without any flag. Only the explicit `--ozone-platform=x11` run used XWayland. Two probes then ran with the default launch and with explicit `--ozone-platform=wayland`, which behaved identically, while recording Hyprland's `.socket2` event stream:

1. A programmatic reopen through the library bridge did not focus the reader.
2. A **compositor-delivered key event** reopened the PDF. Hyprland first focused the library (`hl.dsp.focus`), the test focused the **Open Sample PDF** button in the DOM, and Hyprland sent Return to the library surface (`hl.dsp.send_shortcut`). The button press reopened the existing PDF window, and its `focus()` produced exactly one compositor event: `urgent>>` for that PDF window. The compositor's active window stayed the library.

The activation request therefore reaches the compositor through the Wayland path, and the current policy turns it into an urgency hint instead of focus. No unprivileged pointer-injection tool is installed, so a physical mouse click was not automated. The compositor-originated key event is the closest available stand-in. Because the denial follows the configured `focus_on_activate` policy rather than token validation, a physical click is expected to behave the same; that is an inference, not an observation. Hyprland configuration was not changed, and a class-scoped activation rule was rejected by the user as too blunt and machine-specific.

Resolution: M1-02 is **closed as platform-limited, with a narrowed requirement**. The spec and A5 now say reopening reuses the existing reader window and requests activation; where the compositor denies it, one click brings it forward. The native test now asserts the following: no new window or webContents; the same window/contents IDs and three windows total; the reader is visible with its content intact; and exactly one activation request (`BrowserWindow.focus()`). Its initial-focus and focus-loss setup assertions remain. Only the reopen `isFocused()` assertion was removed. Temporarily deleting the coordinator's reopen `focus()` call made the test fail with zero activation requests. The same policy applies when a second launch finds the library already open, so that criterion was narrowed the same way. The spec now says a second launch reopens a closed library, or reuses the open one and requests activation. A new native case keeps a reader open, launches a real second process, and asserts several things: the second process exits 0, the library keeps the same window/contents IDs and stays visible, no window is created, and exactly one activation request arrives. The same `focus()` mutation fails both activation cases. With the call restored, the full `mise run smoke` passes all 25 native cases. The test harness accepts `BORGES_ELECTRON_FLAGS` (for example `--ozone-platform=wayland`) for future backend checks.

Observed session: Arch/Hyprland 0.57.0 (Lua configuration), native Wayland clients with XWayland available, Samsung C32F391 on HDMI-A-1 at 1920×1080 and scale 1. This is one display configuration, not coverage of other scaling/backends. The shell's profile lock is not the future exclusive library-root lock. No progress persistence, reader rendering, packaged distribution, or resource/performance budget is claimed.

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

*Superseded by M2-01:* the diagnostic database below was replaced by the library catalog; existing `runtime-check.sqlite` files are left untouched and unused. Startup committed one launch counter in `runtime-check.sqlite` inside the diagnostic Electron profile. The existing validated runtime-info bridge exposes a read-only result; reloads and runtime-info calls do not write or increment the counter. The default remains the separate `borges-development` profile; `BORGES_DEV_PROFILE` can isolate a run. This is **not the library catalog**, its identity/schema, or reader progress. No user book or production library path is opened. The schema initializes only an empty, version-zero database; schema and initial row are created transactionally, and subsequent launches retain the existing marker while incrementing the committed count.

The packaged persistence test shuts down Electron, independently reads its committed row and supplies a Unicode marker, then launches a fresh process with the same profile. The second process reads that marker and commits count two. Packaged startup refuses a future schema and a damaged supported schema with exit code 1 and a stderr diagnostic; both files remain byte-for-byte unchanged. Unit tests additionally cover a populated unversioned database, a missing probe row, and a real SQLite trigger failure after a row update: rollback preserves count one and retry commits count two. The initial four focused storage tests failed before implementation; the packaged development-URL regression also failed before its fix.

Review covered the new database module, startup/diagnostic wiring, packaging script/configuration, existing startup test, new unit/native cases, and affected documents, including untracked files. No unresolved in-scope finding remains. Production catalog migrations (including consistent snapshots before destructive changes and failure recovery), root locking, filesystem publication/reconciliation, acknowledged autosave/session validation, full packaged security checks, measured performance/disposal budgets, and final launchers/desktop integration remain required in their planned tasks. No destructive schema migration or full A12/A13/A14 acceptance is claimed. M1-02 still blocks milestone-one completion.


## Packaged runtime/resource measurements (M1-07)

*Superseded in part by the [A13 measurements](#a13-500-entry-catalog-measurements): the suite now opens these documents as catalog entries in a 500-entry library instead of substituting fixture bytes. The observations below remain the diagnostic-fixture baseline.*

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

Budgets are about 2–3× the worst observation and use soft assertions, so every violation is reported. A deliberately impossible turn budget made the suite fail as expected; the budget was then restored. The suite covers generated diagnostic books on this one machine. It is **not A13**; the catalog measurement is recorded in [A13](#a13-500-entry-catalog-measurements). The budgets should be recalibrated from evidence, never loosened to get a pass.

Memory is the sum of kernel PSS (`/proc/<pid>/smaps_rollup`) over Electron's `getAppMetrics()` processes. RSS is also recorded but double-counts shared pages. Findings:

- **Content renderers are shared across readers.** Each reader shell has its own renderer, but both books' `borges://reader` content frames ran in one renderer process in every run (`sharedContentRenderer: true`). That process grew from 104–122 MiB to about 200 MiB after the two searches. It exits only when the last reader closes; the suite asserts that it does. Each book remains a separate window/frame tree without a host bridge. The consequence is crash and memory containment: one book's renderer crash or memory growth affects the other reader. Give each reader a distinct content origin if milestone five's crash-containment checks require separation; this task did not change the reader origin.
- **Closing readers releases renderers.** Shell and content processes leave the metrics within 100 ms, and the window count returns to the library only.
- **Main-process growth is reclaimable, not an observed leak.** The main (Browser) process gains about 5 MiB of native memory per two-reader open/close cycle while its JS heap stays at 5–8 MiB. A throwaway uninstrumented probe (a scratch copy of the artifact cycling readers from main, without Playwright) showed the same slope and a drop back near baseline at cycle 16. The Playwright 20-cycle run dropped at cycle 7. The cause (for example deferred native-object finalization) is not established. A long session with many opens has not been tested beyond 20 cycles.
- **The PDF search scan is the slowest interaction.** A 400-page scan takes about 0.85 s before the last-page hit, and building 1,420 result rows adds about 0.5 s. Results arrive incrementally, so the first row appears within 53 ms. Very large PDFs scale linearly; milestone five's incremental-search work should keep cancellation and row rendering bounded.

Limitations: cache eviction uses `dd iflag=nocache` (POSIX_FADV_DONTNEED) after `sync`. It evicts only the artifact/profile files, and `fincore` confirms the executable has no resident pages. System libraries stay cached, so this is a partial cold start, not a post-boot measurement. Dropping the whole cache needs root and was not done. No other display scale, backend, multi-monitor setup or GPU was measured. Book bytes are served from the artifact rather than the future library root.

## Catalog schema, migrations and root lock (M2-01)

Implemented and reviewed on 2026-11-03 without dependency changes. The diagnostic `runtime-check.sqlite` probe is gone; startup now locks the configured library root and opens `catalog.sqlite` through `src/storage/` before any window opens.

Library root: `BORGES_LIBRARY_ROOT` (must be absolute) wins. Otherwise unpackaged development builds use `<Electron profile>/library`, so `mise run dev` and the native tests never open a real library. Packaged builds use `$XDG_DATA_HOME/borges/library`, ignoring a relative `XDG_DATA_HOME`, else `~/.local/share/borges/library`. All test/measurement launches of the packaged artifact set `XDG_DATA_HOME` to a temporary profile; `~/.local/share/borges` was confirmed absent afterwards. **Running `dist/borges-runtime-check/borges` by hand without an override creates and locks the real default library root.**

```sh
BORGES_LIBRARY_ROOT=/tmp/borges-library ./dist/borges-runtime-check/borges
```

While running, the root contains `catalog.sqlite` with its WAL sidecars, `library.lock` and its journal, `library.lock-owner.json`, and `files/`, `covers/`, `staging/` and `recovery/`. After a clean exit only `catalog.sqlite`, `library.lock` and the four directories remain, which is the closed-folder backup unit. Startup refusals print `Borges cannot open its library: …` to stderr and exit 1. This covers another process holding the lock, a newer schema, a foreign or unreadable database, a damaged schema, and a failed upgrade. They are not yet shown in a window.

Evidence (all on real files/processes, no SQLite or filesystem mocks):

- `mise run check`: strict types, Biome, 87 unit cases, build. `tests/unit/catalog.test.ts` covers the following. Root resolution and durable-path rules. Symlink-escape rejection. Creation, identity and closed-folder layout. A copied root opened after the original was moved away, with the original left independent. Schema invariants: the current revision must belong to its book; non-durable revision paths are rejected; positions are format-matched and bounded; sibling names are unique, including roots; cycles are rejected; branch deletion keeps books; subject keys deduplicate; Trash entries are well formed and owned. Refusal of newer, unversioned-populated, foreign-`application_id`, unreadable and four kinds of damaged catalogs, each byte-identical afterwards and with the lock released. An upgrade with a retained, verified snapshot of the old data, run once. Rollback of a migration that throws after partial destructive work and of one that leaves a foreign-key violation, followed by a successful retry.
- Real child Node processes (`tests/unit/storage-child.ts`): a live holder in another process is refused with its PID; after `SIGKILL`, acquisition succeeds and reports the stale record. A process killed in the middle of an upgrade transaction, after uncommitted pages had reached the WAL, leaves schema 1 with its data intact. The next upgrade then succeeds. A forged owner record naming a live PID does not block startup.
- Mutation checks: removing `locking_mode = EXCLUSIVE` fails both lock-conflict tests. Removing the upgrade transaction fails both rollback tests and the kill-during-upgrade test.
- `mise run smoke-packaged`: 5 cases on the relocated artifact. (1) The XDG default root is created; readers still render; a section written externally while closed survives a restart with the same library ID; a copied root launched through `BORGES_LIBRARY_ROOT` after the original was renamed keeps that ID. (2) A second profile pointed at a running instance's root exits 1, naming the holder's PID, while the holder stays usable. After the holder is `SIGKILL`ed, the second profile opens the same library and reports the recovered stale lock. (3–5) Newer-schema, damaged-schema and foreign-database catalogs are refused with explanations and byte-identical files.
- `mise run smoke`: 25 native cases pass, including the startup check of the development catalog layout. `mise run measure` passes every budget. Launch timing is now measured to the window showing the validated catalog identity: warm median 0.64 s (was 0.52–0.59 s with the diagnostic counter), evicted max 2.94 s, first run 3.59 s. This was one run, before two small review fixes to lock-owner error cleanup and Trash ownership, which do not affect startup timing.

Limits: lock exclusion relies on POSIX advisory locks, so the root must be local (not NFS/odd FUSE). Startup refusals are stderr-only. A catalog with user-added indexes counts as damaged. Snapshots are never pruned. Schema 1 does not persist session generation. No progress endpoint, file publication/reconciliation, library service, or 500-entry/catalog-search measurement exists yet; the planned milestone-two tasks own those.

## Progress storage and session generations (M2-02)

Implemented and reviewed on 2026-11-03 without dependency changes. Schema 2 is the first production migration. It adds `books.session_generation` and `positions.generation`, and existing schema-1 catalogs upgrade after a verified snapshot. `src/library/progress.ts` holds the storage half of the progress contract; see [architecture](architecture.md#process-and-content-boundaries). No IPC endpoint calls it yet: reader windows still open diagnostic fixtures, not catalog books, so sender-window binding and the native forged/stale checks move to M2-05.

Evidence:

- `mise run check`: 112 unit cases. `tests/unit/progress.test.ts` (25 cases, real catalog files) covers the following:
  - grants that restore the last committed PDF position/sizing and an EPUB CFI with chapter/fraction context after closing and reopening the catalog;
  - unknown and deleted books;
  - a reload retiring the earlier window's session, whose late write is rejected while the new generation starts again at sequence 1;
  - an ended session that rejects writes and can be ended only once;
  - replayed and reordered sequences;
  - a replacement-style revision switch that rejects the old session with either revision ID and keeps the retired revision's position;
  - a write naming another book's revision;
  - 13 malformed messages, each rejected without writing;
  - an injected failure on the sizing statement that leaves position and sizing unchanged, with the sequence retryable;
  - a real child process killed after three acknowledged saves, whose last acknowledged position survives;
  - a schema-1 catalog whose old position survives the upgrade and is superseded by the first write of a new generation.
- Mutations fail tests: dropping the revision, generation or sequence check, or not advancing the generation on a grant.
- `mise run smoke-packaged`: 6 cases. The new case upgrades a real schema-1 catalog in the relocated bundled runtime, reports `upgradedFrom: 1` with the same library ID, and leaves exactly one verified schema-1 snapshot. `mise run smoke`: all 25 native cases pass with schema 2.
- Save latency: a scratch script made 100 sequential committed saves in a temporary library on `/home` (btrfs on the 7200 rpm HDD, WAL with `synchronous = FULL`). Two runs gave a median of 41.6 ms, p95 41.8–41.9 ms and a maximum of 50–73 ms. This meets the one-second persistence target. Each save blocks the main thread for that long, so M2-05 should coalesce saves (for example, the latest position at most every few hundred milliseconds plus a flush on close) rather than commit on every page turn.

Limits: no sender binding, IPC or acknowledgement UI yet (M2-05). Status/`last_opened_at` transitions are not applied on open (M2-04). Durability was tested across process kills, not power loss.


## Staged file publication and reconciliation (M2-03)

Implemented and reviewed on 2026-11-03 without dependency or schema changes (the schema-1 `recovery_operations` table already had the needed states). `addFileAsNewBook` is internal: no IPC or UI calls it yet. See [architecture](architecture.md#filesystemdatabase-consistency) for the protocol and rollback rules.

Evidence (real files, real SQLite, real processes; no filesystem mocks):

- `mise run check`: 147 unit cases. `tests/unit/import.test.ts` (35 cases):
  - sniffing of every fixture, a PDF header inside and beyond the first KiB, empty/text/truncated files, a ZIP without `container.xml` and one with a wrong `mimetype`;
  - PDF and EPUB fixtures added with `sha256sum`-computed hashes, byte-identical published copies, unchanged source bytes/mtime, an empty `staging/`, durable Unread/unarchived/unfiled rows after reopening, and a working `beginReaderSession` grant;
  - unsupported names, missing sources and directories rejected without a record; three content mismatches rolled back;
  - an injected failure at each of the six protocol points rolled back with no partial or published bytes left;
  - a rollback whose removal fails (read-only `files/`) stays open, is retried without being double-reported, and succeeds once removal works;
  - a child process (`tests/unit/storage-child.ts import-and-stop`) `SIGKILL`ed at each protocol point: the leftover state is checked first (including a partial copy smaller than the source when killed mid-copy, and bytes already at the final path when killed between rename and its record), then reconciled to no book and no managed bytes; a second start finds nothing to do;
  - a kill right after the catalog commit keeps the book and its bytes;
  - a published copy altered after the kill, plus stray `staging/` and `files/` entries, retained and reported on two consecutive starts; a symlink at a staged path retained without being followed.
- Mutations fail tests: skipping the digest comparison, ignoring the published path, skipping the content check, treating non-regular files as removable, skipping in-process rollback, and treating only failed records as known managed files.
- `mise run smoke`: 26 native cases. The new case kills a real import mid-copy, then launches Electron on that root. Diagnostics report one rolled-back operation and one unrecognized file. After exit `staging/` is empty, the stray file is kept, the operation is abandoned and no book exists. `mise run smoke-packaged`: 6 cases. `mise run measure`: within budget.
- Startup order: reconciliation is the first `await` in startup. It runs after the protocol, permission and network handlers are installed and before IPC handlers and the first window, so no content request is served before the offline boundary exists. An earlier draft awaited it before those handlers; that was moved defensively, not because a leak was observed.

Known pre-existing flake: two isolation cases that call `net.fetch` through Playwright's `electronApplication.evaluate` occasionally fail with `TypeError: Request is not a constructor`. They failed 1 of 30 runs on the unchanged baseline and 2 of 30 with this change. A probe found `globalThis.Request` undefined in that evaluate context in some baseline launches too. Each full serial `mise run smoke` after the fix passed 26/26. This is unrelated to M2-03 and was not investigated further.

Limits: no duplicate detection, metadata/cover extraction, sections, batch/folder import, cancellation, or encryption/parse validation (milestone four). The EPUB sniff tolerates a missing `mimetype` entry. Reconciliation of replace/delete/restore/purge is not implemented. Durability was tested with process kills, not power loss. Messages go to stdout/stderr only. Copying/hashing are async, but each state commit is a synchronous ~40 ms SQLite commit on the main thread (four per import).

## Library query/search service (M2-04)

Implemented and reviewed on 2026-11-03 without dependency or schema changes. The service is internal: no IPC or UI calls it yet. See [architecture](architecture.md#library-service-m2-04) for the contract.

Evidence (real catalog files and SQLite; no mocks):

- `mise run check`: 169 unit cases. `tests/unit/library.test.ts` (22 cases) covers:
  - scope: All Books hides archived books unless included and deleted books always (also from search and `getBook`); Archive shows only archived, live books even with the toggle; Unfiled lists books without memberships; Currently Reading sorts by last opened and Archive by last archived; title order ignores case/accents, compares numbers numerically, then sorts by first author (none last) and ID;
  - search: every term must match a title, author or subject (terms may match different fields), case-insensitively including `ß`/`SS`; `%` and `_` are literal; author/subject filters match whole names; filter terms are counted per view; search filters the selected section branch and the Archive; malformed queries and missing sections are rejected;
  - sections (A2): one book in two nested branches is listed and counted once; the deletion preview and result report 4 sections, 2 books and 1 newly unfiled book; after reopening, the surviving branch and Unfiled are correct; trimmed, case-insensitive sibling names including root siblings; case-only self-rename; moves into the branch itself are rejected, as are destination name clashes; adding keeps other memberships; batches with an unknown or deleted book add nothing; counts exclude archived books unless included;
  - status (A4): the spec table, including Finished and archived-unread reference opens, Archive time kept on a repeated archive, Finish without unarchiving, and Start Rereading. Rereading unarchives, resets the position, keeps sizing and other books' positions, and makes the previously open session's late write fail with `stale-session`. Deleted and unknown books are rejected;
  - metadata: ordered authors, case-insensitive subject deduplication keeping the first spelling, manual flags only for edited fields, an empty list as a manual clear, and an injected failure on the last statement (temporary trigger) that leaves title, authors and flags unchanged;
  - a 500-entry catalog with independently computed result counts for search, author filter, section branch and archive scope.
- Mutations fail tests: dropping the deleted or archived scope, `some` instead of `every` for terms, a non-recursive section view, substring author filters, no case folding, unread-to-reading on archived books, no generation advance on reread, re-archiving overwriting the time, no subject deduplication, no self-exclusion in the sibling-name check, a wrong newly-unfiled count, no live-book check on membership, and a self-only cycle check.
- Timing: a scratch script built a 500-book catalog on `/home` (1–2 authors and 2–3 subjects per book, 54 nested sections, every fifth book archived), then ran each query 50 times under Node 26 and under Electron 45's Node 24 (SQLite 3.53.4). Medians: All Books 2.2 ms (400 rows), with archived 2.7 ms, two-term search 2.8 ms, author filter 2.2–2.5 ms, section branch 0.7–0.8 ms, section tree 0.9–1.0 ms, filter terms 2.9–3.0 ms; every p95 was under 3.6 ms. A metadata edit commit takes about 42 ms (the HDD's `synchronous = FULL` commit), like a progress save. Search folds and sorts in JavaScript after one scoped SQL query; at this scale no stored search keys are needed.

Limits: no IPC/UI, covers or Trash listing (deletion and its restore context arrive in milestone four; tests set `deleted_at` directly). `recordSuccessfulOpen` is not yet called by a reader, because readers do not open catalog books until M2-05. These are not the A13 measurement: A13 needs two open catalog readers in the packaged app. Collation uses the system locale, so sort order follows `LANG`.

## Catalog readers and central progress saves (M2-05)

Implemented and reviewed on 2026-11-03 without dependency or schema changes. Catalog books open in reader windows and save their position through the main process; see [architecture](architecture.md#process-and-content-boundaries) for the IPC contract. The library window lists All Books with status and a Read button (diagnostic, not the milestone-three library UI). Diagnostic fixture readers are unchanged and hold no session.

Evidence (real catalogs, real Electron windows, real reader engines):

- `mise run check`: 178 unit cases. `tests/unit/sessions.test.ts` (9 cases) covers coalescing to one commit of the latest position per 250 ms interval with its acknowledgement; flush on window close followed by rejection; a reload flushing the old page and rejecting its late message as stale; Quit flushing two readers; positions forged for another window's book or from a window without a session (`not-assigned`), a wrong generation and a malformed location; replayed and reordered sequences, including against a pending write; a storage rejection (stale revision) that does not raise the sequence floor; an injected storage failure retained and committed at the next flush; and successful-open recording only for the window's current generation.
- `mise run smoke`: 30 native cases. `tests/e2e/catalog-readers.spec.ts` (4 cases) seeds real catalogs through `addFileAsNewBook` before launch (`tests/e2e/desktop.ts` `catalog` option) and checks the catalog directly:
  - a PDF and an EPUB opened together: Unread → Currently Reading on open (also in the library list), page 3 and a searched EPUB passage at font size 24 committed and acknowledged in the shell; the PDF resumes on page 3 after closing and reopening; both resume after a real restart (`LANTERN PASSAGE 24.` visible, font size 24, no notice); a damaged EPUB locator reopens near the saved chapter with the approximate-restoration notice;
  - with the commit interval lengthened to 10 s (`BORGES_SAVE_INTERVAL_MS`, honoured only by unpackaged builds), nothing is committed before closing, closing the reader commits page 2, and Quit commits page 3;
  - A14 end to end: the EPUB window forging the PDF's position and the library window sending one both get `not-assigned`; the PDF window's wrong generation, replayed sequence and malformed or wrong-format locations are rejected (`stale-session`, `out-of-order`, `invalid`) and the stored row is unchanged; engine and chapter frames have no `borges`/`development` bridge; positions and an `opened` message posted by a chapter frame to its parents are ignored (no save, no notice); after a reload the previous page's generation is stale;
  - a corrupt PDF that passes the import sniff fails to open with an alert and stays Unread with no position; a deleted managed file reports "could not be read from the library" and keeps its entry.
- Mutations fail these native tests: no flush when a session ends, no book binding, no generation binding, and the shell accepting messages from any frame.
- `mise run smoke-packaged`: 7 cases. The new case opens a catalog PDF in the relocated packaged runtime, ignores `BORGES_SAVE_INTERVAL_MS=600000` (page 2 committed within 2 s), resumes on page 2 after a restart, and leaves the source bytes unchanged. `mise run measure`: 2 cases within budget.
- The known `net.fetch`/Playwright flake (M2-03 notes) failed one isolation case in one of three full `mise run smoke` runs; the other two runs passed 30/30.

Limits: the A13 measurement is recorded [separately](#a13-500-entry-catalog-measurements). A position becomes durable only after it reaches main, a few milliseconds after the engine finishes drawing the page, and is committed at most 250 ms later or on close/Quit; a renderer or process crash loses at most that interval. The engine is handed its bytes through two copies (IPC, then a transferred copy). Reader error actions (retry/replace/back to library) and the reread/replace/delete flows that will end sessions through `ReaderSessions` are later work. Book bytes are read whole into memory, as before.

## A13 500-entry catalog measurements

Implemented and reviewed on 2026-11-03 without dependency or schema changes. `mise run measure` now seeds a representative 500-entry library on the home HDD and measures the packaged, relocated artifact against it. The two book-length documents from M1-07 are opened as **catalog entries** through the library window, with central progress saves, instead of substituting fixture bytes. The only product change is that `library:books` accepts an optional library query (validated by `parseBookQuery`; library window only), so catalog search can be timed through real IPC. Session: the M1-07 machine and display (i5-9400, 11.5 GiB, UHD 630 with GPU compositing, kernel 7.2.14, Hyprland Wayland, one 1920×1080 display at scale 1, `/home` btrfs `relatime` on the 7200 rpm HDD). Electron 45.2.1, Chromium 156, Node 24.22.1.

Catalog (`tests/measure/catalog.ts`, deterministic and created): the plan is built through the real `addFileAsNewBook`, `editMetadata`, section and archive services. It has 299 PDFs and 201 EPUBs, 86 MB of distinct generated files from 6.9 KB to 2.3 MB (4–63-page PDFs and 2–15-chapter EPUBs with images, plus the 400-page PDF and 40-chapter EPUB), 120 authors (1–2 per book), 40 subjects (2–3 per book), 60 sections three levels deep (one or two memberships per book, 50 unfiled), and 71 archived books, leaving 429 in All Books. Seeding takes 151–157 s, almost all of it ~2,600 synchronous `synchronous = FULL` commits. Expected query counts come from the plan's construction, not from the query code. Poppler `pdfinfo`/`pdftotext` and `unzip -t` independently confirmed sampled filler books (page counts from the plan formula, opening headings, intact archives).

**No eager loading** is checked with kernel access times. Every managed file's atime is backdated, keeping its mtime, so `relatime` advances it on the next read. After the 8 catalog launches (including cache-evicted ones), no book file had been read. After the reader test (two opens, five resumed reopen cycles, library queries), exactly the two opened books' files had been read. This is also the positive control. A deliberate mutation that reads every revision at startup failed the check, reporting all 500 files. No thumbnail or cover jobs exist yet (covers arrive in milestone four). The library idles with exactly one page renderer, and only the two opened books changed status or gained a position.

Results from five full runs (seeded each time), with every budget met; the last is the recorded report. Times include Playwright's launch/CDP and polling overhead:

| Measure | Observed | Budget |
| --- | --- | --- |
| First launch, fresh profile, empty library | 3.5–3.6 s | ≤ 8 s |
| Warm launch, empty library, median of 3 (comparison) | 0.59–0.66 s | — |
| Warm launch to all 429 entries listed, median of 5 | 0.62–0.66 s (max 0.85 s) | ≤ 1.5 s |
| Launch with artifact/profile/library evicted from page cache, max of 3 | 3.1–3.4 s | ≤ 7 s |
| Catalog query IPC round trip, median (All Books / searches and filters / Unfiled, Archive) | 5.3–6.3 / 3.0–4.3 / 1.0–1.4 ms | — |
| Catalog query p95, idle / two readers open | ≤ 6.8 ms / ≤ 23.8 ms | ≤ 50 ms |
| Catalog reader open to opening text, PDF / EPUB | 0.66–0.71 s / 0.63–0.67 s | ≤ 1.5 s |
| Resumed reopen at the saved page/chapter, max of 5 | 0.56–0.69 s | ≤ 1.5 s |
| Page turn p95, PDF / EPUB (20 turns) | 87–118 ms / 118–125 ms | ≤ 300 ms |
| Turn to acknowledged committed position, PDF / EPUB, max of 5 | 390–401 ms / 336–344 ms | ≤ 1 s (spec target) |
| First search hit | ≤ 67 ms | ≤ 250 ms |
| Full PDF search, common / rare | 1.38–1.41 s / 0.85–0.88 s | ≤ 3.5 s |
| Full EPUB search, common / rare | 0.23–0.41 s / 0.11–0.12 s | ≤ 1 s |
| Closed reader renderer exits | ≤ 181 ms | ≤ 1 s |
| Total PSS: library idle with 429 listed entries | 280–283 MiB | ≤ 400 MiB |
| Total PSS: two readers after both searches | 548–557 MiB (430–435 MiB before search) | ≤ 800 MiB |
| PSS after closing readers, above idle | 30–34 MiB | ≤ 60 MiB |
| PSS growth over 5 resumed open/close cycles | 5–14 MiB | ≤ 100 MiB |

Budget changes: the evicted-launch budget rose from 6 s to 7 s (2× the worst observation), because eviction now also covers the catalog and its 86 MB of books. The query budget is new; the acknowledgement budget is the spec's one-second persistence target, not an invented guarantee. The other budgets are unchanged and still have at least 1.4× headroom. A deliberately impossible query budget made the suite fail with every violation reported, and was then restored.

Findings:

- **500 entries cost little at launch.** Warm launch with the listed catalog matches the empty library within noise. The evicted launch is about 0.2–0.5 s slower than M1-07's, which fits reading the evicted catalog. The library renderer holds about 83 MiB with the diagnostic 429-row list, so idle PSS is about 40 MiB above the empty library (238–242 MiB in M1-07).
- **Catalog queries are interactive.** Every query is under 7 ms p95 through IPC while idle. With two readers open, each run had one All Books outlier of 11–24 ms. The cause was not established; a synchronous ~40 ms progress commit or a GC pause on the main thread are plausible.
- **Saves land well inside one second.** A turn reaches a committed, acknowledged position in about 330–400 ms: the 250 ms coalescing interval plus the HDD commit and drawing.
- **Catalog readers behave like the M1-07 diagnostic readers.** Both content frames still share one renderer process, which peaks at about 195 MiB after the searches. Opening takes about 0.1–0.4 s longer than serving fixtures did, which fits the extra IPC copy of the bytes and session grant. Closing readers leaves 30–34 MiB above idle (M1-07: 14–17 MiB). The open/close cycles bring it back to within ±4 MiB of idle, consistent with M1-07's reclaimable main-process growth; long sessions beyond 5 cycles were not rerun.

`BORGES_MEASURE_CATALOG=<closed library root built from this plan>` copies a prebuilt library instead of seeding. It is for iterating on the suite only, and the report marks such runs. Recorded results above always seeded. Build such a root once with `mise exec -- node scripts/build-measure-catalog.ts dist/a13-template` (about 2.5 minutes; `dist/` is ignored by Git). Rebuild it whenever `tests/measure/catalog.ts` or `representative.ts` changes. Do not edit `src/` while `measure` runs: each run rebuilds and packages the working tree.

Limits: one machine, display and scale; partial cold cache, as in M1-07. These runs used the diagnostic list. [M3-02](#library-window-browsing-m3-02) re-measured the suite with the library grid, which renders in batches of 100. Cover costs remain for M3-05/M3-08 (no thumbnail jobs exist to bound yet). Section views and filter-term listing have no IPC yet; their service timings are in [M2-04](#library-querysearch-service-m2-04). Catalog seeding needs about 2.5 minutes on this HDD, which makes `measure` take about 4 minutes.

## Library IPC (M3-01)

Implemented and reviewed on 2026-11-03 without dependency or schema changes. The library window can now call the whole M2-04 service; see [architecture](architecture.md#library-service-m2-04) for the channel contract. Requests return a typed result instead of throwing, so the diagnostic list and the A13 measurement were adapted. The diagnostic library list now also refreshes on `library:changed`. Native catalog helpers moved to `tests/e2e/catalog.ts`.

Evidence (real catalogs, real Electron windows):

- `tests/e2e/library-ipc.spec.ts`, case 1, seeded with the Known PDF and Reflowable EPUB:
  - Metadata: ordered authors, case-insensitive subject deduplication, a blank title (`invalid`), an unknown book, filter terms and an author filter.
  - Sections: a parent and child section holding the PDF are counted once (A2); a case-insensitive root name clash; a move into its own child (`section-cycle`); a batch naming an unknown book adds nothing; rename and membership removal; a deletion preview and the deletion itself (2 sections, 1 book, 1 newly unfiled) leaving both books Unfiled.
  - Status and Archive, independent (A4): Finish; Archive hiding a book from All Books but not from Archive; Unarchive.
  - The catalog is checked directly, including the manual-authors flag. Exactly 11 change notifications arrive, one per successful change and none for reads or failures. Malformed queries are refused. A reader window calling four channels is refused and changes nothing.
- Case 2: the library is notified when a reader's open makes the PDF Currently Reading. The reader is turned to page 3, then the book is marked Finished and Archived while open. Start Rereading returns Currently Reading and unarchived. The same window reloads to "Page 1 of 3" with a higher generation and the same revision, the library list shows Currently Reading, and a write carrying the old generation is rejected as `stale-session` with page 1 kept.
- Mutations fail these cases: dropping the reader reload, the notification on open, Archive's notification, or the sender check.
- `mise run check`: 178 unit cases. `mise run smoke`: 33 native cases. `mise run smoke-packaged`: 7. `mise run measure`: within budget.

Limits: there is no library UI yet (M3-02 to M3-04). A reader's window title does not follow a title edit. Rereading an open reader ends its session before reloading. A position the old page sends in that interval is reported in that page as not saved, just before it reloads.

## Library window browsing (M3-02)

Implemented and reviewed on 2026-11-04 without dependency or schema changes. The library window (`src/renderer/src/library/`) replaces the diagnostic list; styling is provisional until M3-06.

- **Sidebar:** All Books, Currently Reading, Finished, Unfiled, the nested section tree (unique-book counts, announced as each button's description), Archive and Trash. Trash is a placeholder until deletion arrives in milestone four.
- **Toolbar:** search within the selected view, Author and Subject filters listing the view's terms with counts, an Include archived toggle (absent in Archive), and Grid/List layout.
- **Results:** cards (a cover placeholder until M3-05, title, authors, status and an Archived badge) or a compact table. Each book's button is named by its title and opens or focuses its reader.
- **Behavior:** search text carries across views; author and subject filters reset because their choices belong to a view. A deleted selected section falls back to All Books.
- **Empty states:** an empty library (import arrives later), all books archived (with Show Archive), an empty view, and no matches (with Clear search and filters).
- **Development area:** the diagnostic fixture readers, Quit and the runtime diagnostics stay in a footer.

**Bounded rendering.** The first measurement with all 429 cards rendered failed two budgets: memory after closing readers was 90 MiB above idle, and one resumed open took 1.67 s. A throwaway probe on the packaged app with the 500-entry catalog showed what grows the library renderer: its JS heap stayed 10–32 MiB and its DOM was constant, but its PSS rose about 94 MiB over 10 refreshes that changed a title, and about 130 MiB over 10 hide/show cycles. Under repeated resizes it plateaued near 380 MiB, then fell to 148 MiB after 15 s idle. So this is reclaimable rendering memory that scales with the laid-out grid, not a leak; a tiling compositor resizes the library window whenever a reader opens.

Two fixes followed. Refreshes that return identical data keep the previous state, so they render nothing; the focus-triggered refresh was dropped, since main pushes every change. Results also render in batches of 100: the next batch loads when the end is within 800 px of the viewport (so Tab and scrolling load continuously), a Show more button remains as a fallback, and a new view or query starts again from the first batch. A CSS `content-visibility: auto` attempt made reader opens 3.4–4.5 s and was reverted.

Evidence:

- `tests/e2e/library-window.spec.ts` (5 cases, seeded catalogs with metadata, nested sections and an archived book set up through the library service):
  - A3 through the UI: view contents and order, unique section counts, Unfiled, Archive, the Trash placeholder, multi-term search, the include-archived toggle, the search carrying into a section view and Archive, no matches with clearing, filters with counts and their reset on a view change.
  - Tab order from the search box through the toolbar to the books, a visible focus outline, opening with Enter, the library updating to Currently Reading without being refocused, list layout cells, and the deleted-section fallback.
  - The all-archived and empty-view states, and an empty library.
  - 130 entries: 100 rendered in numeric title order; focusing the 100th book loads the rest and keeps focus; another view starts from 100 again; scrolling loads the rest.
- Mutations fail these cases: dropping the include-archived flag, the change-notification refresh, the deleted-section fallback, batching, or the batch reset.
- Existing native tests now find books by title in the Books list (`tests/e2e/catalog.ts` `bookButton`), and find the library window by its Library navigation instead of the former heading, which only matched while the window identity loaded.
- `mise run check`: 178 unit cases. `mise run smoke`: 38 native cases. One full run failed only the known `net.fetch` isolation flake (see M2-03), and the next two full runs passed 38/38. `mise run smoke-packaged`: 7.
- `mise run measure` with the UI, in three seeded runs (the suite now opens the two books by searching the library and browses every batch after the reader measurements), all within budget:

| Measure | Observed (M2-05 plain list in A13) |
| --- | --- |
| Warm launch to 429 counted and 100 rendered, median | 0.67–0.71 s (0.62–0.66 s) |
| Evicted launch, max | 3.0–3.3 s (3.1–3.4 s) |
| Catalog query p95, idle / readers open | ≤ 6.6 / ≤ 23.8 ms (same) |
| Reader open, PDF / EPUB | 0.65–1.18 s / 0.55–0.66 s; one PDF first-open outlier per run or two, cause not established (0.66–0.71 / 0.63–0.67 s) |
| Total PSS idle; library renderer | 294–301 MiB; 91–101 MiB (280–283; 83 MiB) |
| Two readers after search | 565–596 MiB (548–557 MiB) |
| Closed readers over idle | 36–42 MiB (30–34 MiB) |
| Showing all 429 entries | 0.56–0.61 s; 363–391 MiB total, library renderer 159–161 MiB |

Kernel access times still show exactly the two opened book files read. The report also records the library renderer's JS heap and DOM node count.

Limits: covers are placeholders (M3-05), so image decoding is not yet measured. Section management, selection and book actions are M3-03/M3-04. Keyboard navigation between cards uses Tab; there are no arrow-key grid semantics. Appearance is provisional.

## Sections and memberships in the UI (M3-03)

Implemented and reviewed on 2026-11-04 without dependency or schema changes.

- **Sections:** the sidebar offers New section under the tree. A selected section offers New subsection, Rename section, Move section and Delete section above its results. The move choices are Top level and every section outside the moved section's own branch, with the current parent preselected. Forms trim names; Escape or Cancel closes them. The service's explanation (for example "Another top-level section is already named “Fiction”.") appears without losing the typed text. A created section is shown at once.
- **Deletion:** a modal dialog states the subsections deleted, the books losing a membership, and those becoming Unfiled, from the deletion preview, and says that no book is deleted. Cancel changes nothing.
- **Memberships:** each book has a "Select <title>" checkbox. With a selection, a sticky Selected books bar can add the books to any section (shown by path, keeping other memberships) and, in a section view, remove their direct membership there. If the books are still listed through a subsection, the result says so. The selection resets when the view changes and drops books that leave the view.

Evidence: `tests/e2e/library-sections.spec.ts` (2 cases). Case 1 covers creation with trimming and focus, a case-insensitive clash message, a subsection, rename, a move to the top level, move choices that exclude the section's own branch, and the resulting trees. Case 2 is A2 through the UI: two books added to a child section and one also to its parent, unique counts, the parent listing each book once, removal from the child leaving the EPUB Unfiled, a parent removal that keeps the PDF listed through the child, the zero-removal explanation, and a cancelled then confirmed branch deletion with the stated counts. After it, all three books are Unfiled; the catalog still has 3 books and has 0 sections and 0 memberships. Mutations fail these cases: offering the section's own branch as a destination, keeping removed books selected, and deleting without confirmation. The M3-02 Tab-order case now includes each book's checkbox. `mise run check`: 178 unit cases; `smoke`: 40 native cases; `smoke-packaged`: 7; `measure` (prebuilt catalog): within budget.

Limits: no drag and drop, no multi-section add in one step, and no keyboard shortcut for selection. Section-tree undo is not provided (spec default).

## Book status, Archive and details in the UI (M3-04)

Implemented and reviewed on 2026-11-04 without dependency or schema changes.

- **Status actions:** the Selected books bar offers Mark Finished, Archive or Unarchive (whichever applies to the selection), and Start Rereading…. Rereading confirms in a modal dialog first, because it clears positions, unarchives, and restarts any open reader at the beginning. Actions run per book through the service's transition table. The result names the count changed and any book that was not changed, with its reason.
- **Edit details:** for exactly one selected book, a modal dialog edits the title, ordered authors and subjects (one per line). Only changed fields are sent, so only those become manual overrides. Subjects compare as a case-insensitive set, so reordering is not an edit. Service validation (for example "Title cannot be empty.") appears in the dialog, and Cancel sends nothing.

Evidence: `tests/e2e/library-books.spec.ts` (2 cases).

- Case 1 is A4 through the UI with real readers and catalog checks:
  - Finish, then Archive, keeps Finished.
  - An archived unread EPUB opened for reference stays Unread and archived.
  - Unarchive keeps Unread and leaves the Archive view, which lists the most recently archived first.
  - A Finished, archived PDF opened for reference and turned to page 3 keeps both.
  - Cancelling Start Rereading changes nothing. Confirming makes the book Currently Reading and unarchived, and its open reader reloads to page 1, with page 1 committed.
- Case 2: Edit details appears only for one selected book; a blank title is explained; title, authors (blank lines dropped, names trimmed) and subjects (case duplicates removed) are saved with all three manual flags. A subjects-only edit of the other book sets only `subjects_manual`. Cancel saves nothing.

Mutations fail these cases: sending every field on save, and rereading without confirmation. `mise run check`: 178 unit cases; `smoke`: 42 native cases; `smoke-packaged`: 7; `measure` (prebuilt catalog): within budget.

Limits: no per-book details panel beyond the dialog, no undo, and batch actions run sequentially (one commit per book, ~40 ms each on the HDD). Covers are M3-05.

