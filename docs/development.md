# Development setup

The development environment is installed on the user's Arch Linux/Hyprland desktop. The diagnostic Electron shell opens one library and named readers with bundled known PDF/EPUB fixtures. Engine navigation/search/sizing, explicit snapshot restoration, diagnostic adversarial isolation, packaged-runtime SQLite/schema handling, catalog readers with central autosave, packaged resource measurements with a 500-entry catalog (A13), and the library window (browsing, search/filters, sections and memberships, status/Archive actions, metadata editing and manual cover correction; M3-01 to M3-05) are verified. Startup refusals and unresolved recovery diagnostics are shown in windows (M3-07). Cover-bearing catalog measurements and lazy-loading/disposal checks are verified (M3-08). The user-chosen Reading room direction (M3-06), batch import (M4-01) and bounded validation with metadata/cover extraction (M4-02) are also verified. Replacement (M4-03) and metadata-duplicate choices (M4-04) are verified. Delete to Trash, Trash browsing and deleted-book restore (M4-05) are verified. Revision restore and Trash-only import choices (M4-06) are verified. Confirmed purge and interrupted-purge startup continuation (M4-07) are verified. Milestone-four acceptance, including an independent populated backup and A13 remeasurement, is verified (M4-08); M5-01 integrated reader controls/search is verified, with the remaining milestone-five tasks and milestone six pending. Selected source files are copied and left unchanged; development uses a separate `borges-development` Electron profile. Its versioned, locked library catalog lives in `<profile>/library` for unpackaged builds; see [M2-01](#catalog-schema-migrations-and-root-lock-m2-01). Reopening an existing reader requests activation; this Hyprland policy answers with an urgency hint rather than focus, a recorded platform limit; see [M1-02 evidence](#multi-window-spike-m1-02).

## Start working

From this directory:

```sh
mise run dev
```

This first builds the isolated reader and its bundled assets, then starts the main/preload builds, local Vite server, and Electron window. Trusted shell React/CSS edits hot reload; reader adapter/content and import-parser changes require restarting `pnpm dev` to rebuild the isolated content bundle; main/preload changes can be watched with `pnpm dev --watch` through mise. Closing the last application window stops the development process. The local server and React-refresh CSP relaxation are development-only; the built app uses local assets and a strict CSP.

The library window opens at All Books over the development catalog in `<profile>/library`. It starts empty: use Import files… / Import folder… to copy PDF/EPUB sources into the catalog. Controlled test seeds can also be added, while the app is closed, with `mise exec -- node tests/unit/storage-child.ts add-books ~/.config/borges-development/library <files…>` (the default development profile). Its Development footer keeps the diagnostic fixture readers, Quit and runtime diagnostics. Use **Open Sample PDF** and **Open Sample EPUB** to exercise separate reader shells. These diagnostic IDs load known fixtures. The extra Image-only PDF, Fixed EPUB, and Obfuscated-font EPUB entries exercise the other fixture variants. Reopening reuses the existing window and requests focus. Readers offer **Open library**; closing the library leaves readers running. The last window exits, or **Quit application** closes all windows. A second launch with the same development profile routes to the existing instance. Closing the library alone stops development only when no readers remain.

```sh
mise run check
mise run smoke
mise run smoke-packaged
mise run measure
```

`check` runs TypeScript, Biome lint/format checks, Vitest, and the production build. `smoke` builds and launches real Electron on the available desktop display. Playwright uses the installed Electron executable; no separate Playwright Chromium download is needed. Headless CI display setup is future work and is not needed on this desktop. `smoke-packaged` separately builds a bundled Electron directory and tests a relocated copy. `measure` builds that directory, seeds a representative 500-entry catalog with 400 covers (about five minutes on the HDD), and records launch, catalog query, reader, save, search, memory and disposal measurements against budgets; see [A13](#a13-500-entry-catalog-measurements) and [M1-07](#packaged-runtimeresource-measurements-m1-07). Run the native suites serially on this desktop; concurrent GUI runs can interfere with input/focus and have exhibited reader-opening timeouts.

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


## Manual covers and library-only serving (M3-05)

Implemented and reviewed on 2026-11-04; unchanged dependency pins. Select one book and use **Choose cover…**. The main-process file dialog accepts PNG/JPEG; validation uses content rather than the name (including files without an image extension). Inputs are bounded to 10 MiB, 16 megapixels and 8192 pixels per side before native decoding. Main stores a PNG thumbnail at most 512×768 in the library, leaving the source untouched. Cancellation or a failed copy/decode/commit keeps the current cover.

Schema 3 rebuilds `recovery_operations` to add `cover`, preserving its rows and partial index after the catalog runner's verified snapshot. Cover publication follows the import protocol, with normalization while the staging record is still pending. The digest describes the normalized bytes. The catalog reference, manual provenance and committed operation state change in one transaction. Before commit, rollback removes only operation-owned regular files with the expected digest (or its partial pending copy); referenced/uncertain files stay for repair. Committed cover files, including superseded ones, are retained and accounted for. Unrecognized files in `covers/` are reported, never deleted.

The grid asks `library:cover` for the current book's opaque token only when its card nears the viewport, with four reads/decodes in flight. The main endpoint verifies library-window identity and canonical containment under `covers/`; the renderer receives image bytes and uses disposable blob URLs. No general filesystem or protocol path is exposed. Offscreen/unmounted cards release their object URLs; the compact list requests no covers. Missing/unusable covers retain the initials/format placeholder. Styling remains provisional.

Focused checks: 21 new storage/validation cases in `tests/unit/covers.test.ts` include a schema-2 migration with retained recovery data, source preservation/manual provenance, failures at all six precommit points, seven real process kills (including an open catalog transaction and postcommit), referenced/uncertain resource retention, orphan reporting, token/path/symlink checks, and byte/dimension bounds. A failing regression showed a damaged cover record could name another operation's staging file; recovery now retains such records. The unit storage cases isolate the native decoder through its explicit callback; they do not claim image decoding works. Two cases in `tests/e2e/library-covers.spec.ts` exercise actual Electron decoding of created PNG/JPEG sources, thumbnail dimensions, library reload and a real process restart, cancellation, truncated-image rejection, reader-sender refusal, and a 130-entry grid's lazy loading/disposal. The image chooser's selected/cancelled result is stubbed at the native-dialog boundary; physical file-picker interaction is not automated. Native screenshot inspection confirms displayed covers in the grid.

`mise run check` passes (199 unit cases, types, Biome and build); `mise run smoke` passes all 44 native cases on rerun. The first full smoke run had 43/44 passes, failing only the previously documented `Request is not a constructor` flake in the existing protocol-isolation test. `mise run smoke-packaged` passes all 8 cases, including schema-1 → 3 and schema-2 → 3 upgrades with verified snapshots. The final native cover case also passes its added process-restart assertion. Direct review covered tracked and new implementation/test files; the operation-path regression was fixed, with no remaining in-scope finding. Two aggregate prebuilt-catalog `measure` runs passed launch/query/turn/save/search/memory/disposal budgets but exceeded the unchanged 1500 ms reopen limit: PDF maxima were 1555 and 1680 ms; the second EPUB maximum was 1501 ms. An isolated unchanged `e3db461` baseline on the same home filesystem passed (PDF/EPUB reopen maxima 699/704 ms). A timed run of the current packaged artifact also passed all reader budgets, with reopen ranges 521–598 ms (PDF) and 475–546 ms (EPUB); the delay did not recur in that run. No speculative runtime change or budget increase was made. The final uninstrumented aggregate run passes both cases and every unchanged budget (`BORGES_MEASURE_CATALOG=$PWD/dist/a13-template mise run measure`); this uses a copied prebuilt catalog without covers, not a newly seeded or cover-bearing measurement. The timing-overrun cause remains unproven; retain these observations when M3-08 extends the measurement. Not covered: extracted covers (milestone four), cover-bearing 500-entry performance budgets (M3-08), power-loss durability, or the final visual design.


## Startup problems in windows (M3-07)

Implemented and reviewed on 2026-11-04 without dependency or schema changes.

Startup refusals show the configured library folder, exact storage/lock explanation and close/resolve/reopen instructions in an independent static Electron window. This works before normal renderer assets, catalog services or IPC are available. The window has no preload or JavaScript; escaped text, a restrictive CSP and denied navigation/windows keep filenames and error text inert. Closing exits 1. A second ordinary launch reuses that window and requests activation rather than opening an unusable library shell. Storage's existing refusal and rollback contracts are unchanged.

After a successful catalog open, reconciliation still runs behind the installed offline boundary before any library work. Main retains unresolved messages for the library-only `library:startup-problems` endpoint. The library displays retained-operation reasons and paths, unrecognized managed files, and failures of the reconciliation pass, with the root folder. Reports survive view changes and reloads; unresolved records are reported again after a real restart. Browsing/organization remain usable. Restart after external repair to reconcile again; the report is a snapshot of that startup, with no automatic deletion or repair actions.

Evidence:

- `mise run check`: types, Biome, all 199 existing unit cases and production build pass. Native coverage exercises the actual new window/IPC/rendering behavior rather than duplicating it in mocked unit tests.
- `mise run smoke`: all 46 native cases pass. The existing killed-import case now checks the visible orphan-file report and reload. Two added cases cover a retained failed operation across reload and process restart (bytes preserved, markup displayed as literal text, section creation still works), and a real managed-directory permission failure with usable browsing. Existing IPC coverage checks an empty report and refusal of reader senders.
- `mise run smoke-packaged`: all 10 relocated-runtime cases pass. Existing refusal cases now inspect the visible window, absent bridges, runtime isolation preferences and exit 1 after closing. Added cases cover a non-SQLite file and an actual schema-2 upgrade failure against a read-only catalog. Refused catalog bytes remain identical. The lock-conflict case also launches a real second process against the refusal profile and verifies one error window while the original holder stays usable. Hostile markup in library paths creates no elements. Existing migration/snapshot and reader restart cases still pass.
- Initial full smoke runs reproduced the previously recorded early `net.fetch`/Playwright failures (`Request is not a constructor` and `ERR_UNKNOWN_URL_SCHEME`). The protocol-isolation case now waits for validated library startup before fetching; all six 403/body assertions remain. Ten focused repetitions and the final full serial run pass. An overlapping rebuild also invalidated one exploratory UI run; final verification ran builds and GUI suites serially.

Both error and recovery views were inspected in native screenshots. This session supplied the available Hyprland X11 display explicitly (`DISPLAY=:1`, `WAYLAND_DISPLAY=wayland-1`, `XDG_RUNTIME_DIR=/run/user/1000`); no compositor configuration changed. Direct code/test/requirements review included both new files and the readiness correction, with no unresolved in-scope finding. No commit was created. Performance was not remeasured; cover-bearing A13 measurements remain M3-08, and final appearance remains M3-06. No repair UI, power-loss claim or broader migration/recovery feature is added here.

## Cover-bearing catalog measurements (M3-08)

Implemented on 2026-11-04 without application, schema or dependency changes. Both final complete runs (fresh-seeded and prebuilt catalog) pass all three measurement cases and every budget. Reports are `dist/measurements/m3-08-seeded-final.json` and `m3-08-prebuilt-final.json`; the fresh seed took 324 s and the complete run 7.7 minutes.

`mise run measure` now seeds 400 distinct created PNG covers through the real cover-publication service alongside the existing 500 books. One fifth of entries deliberately have no cover. The generated PNGs already satisfy the thumbnail bounds (256×384, 384×576 or 512×768); seeding uses an identity normalizer, while M3-05's native tests still verify source-image normalization. The library contains 48.9 MB of covers and 86.1 MB of books, with 343 cover-bearing entries among the 429 unarchived books. Seeding takes about five minutes on this HDD (~4,300 durable transactions), and the full suite about eight minutes. Cover-free templates from earlier milestones are rejected. To build a new template for iteration:

```sh
mise exec -- node scripts/build-measure-catalog.ts dist/a13-covers-template
BORGES_MEASURE_CATALOG=$PWD/dist/a13-covers-template mise run measure
```

Choose an unused template path; the builder refuses existing paths. Measurement runs copy templates rather than using them in place. Recorded fresh-seeded runs omit `BORGES_MEASURE_CATALOG`. Reports remain under `dist/measurements/`, with `BORGES_MEASURE_REPORT` selecting the filename.

The new native case traverses every grid row twice in a fixed 1000×720 viewport, checks decoded visible images against the cover plan, verifies offscreen disposal and reload on return, and switches to List and back. Kernel access times establish that browsing reads exactly the 343 live covers and no books; List reads no covers. Instrumented blob ownership and a 25 ms decode delay expose overlapping jobs: both complete runs peak at four decodes and 15 live URLs, and List releases every URL. Launch/reader timings run without this instrumentation or forced collection. The measurement's batch helper now scrolls and waits for increasing row counts: clicking Show more raced automatic batching when scrolling detached the button. No product behavior changed. Native screenshots show decoded covers and missing-cover placeholders.

Results across the final fresh-seeded and prebuilt-catalog runs, on the same i5-9400/UHD 630, 11.5 GiB, home HDD/btrfs, Hyprland desktop and pinned Electron runtime as the earlier A13 measurements; display variables were supplied as for M3-07:

| Measure | Observed | Budget |
| --- | --- | --- |
| Warm launch to grid, median | 0.67–0.74 s | unchanged 1.5 s |
| Warm launch with visible covers decoded, median | 1.09–1.13 s | new 2 s |
| Evicted launch with visible covers decoded, max | 3.52–4.10 s | new 8 s |
| Idle / two-reader catalog query p95 | ≤ 16.9 / ≤ 17.7 ms | unchanged 50 ms |
| PDF / EPUB first or resumed open, max | 0.69 / 0.87 s | unchanged 1.5 s |
| Position acknowledgement, max | 659 ms | unchanged 1 s |
| Idle / two readers after search, total PSS | 349–352 / 605–617 MiB | unchanged 400 / 800 MiB |
| One / two complete cover traversals, total PSS | 659–662 / 752–755 MiB | new 1600 MiB |

The full-grid budget is separate from idle/reader memory and approximately twice the observed two-pass peak. Initial probes reached 600–611 MiB after one pass and 743–751 MiB after two; a provisional 600 MiB probe bound failed. A diagnostic-only renderer garbage collection reduced a 744 MiB List sample to 450 MiB: releasing URLs does not immediately reclaim all image/rendering memory. Clearing the temporary decoder's source did not improve retention (668/776 MiB) and was reverted. Final measurements neither force collection nor include that experiment. These observations establish reclaimable memory, not a long-session leak-free guarantee.

Verification and review: `mise run check` passes types, Biome, 199 unit cases and build. The final `smoke` run passes 46 native cases; `smoke-packaged` passes all 10. An earlier full smoke had 45/46 passes and five focused repetitions had 4/5 passes: the unchanged A14 chapter-message test intermittently observed a newer EPUB save sequence with identical location/settings; its cause is not established. Its assertions remain intact; the final full rerun passes. Three mutations to disposable packaged copies fail the new case: eager loading reads 80 covers (bound <40), removing the job limit permits 13 decodes (bound 4), and skipping revocation retains 376 URLs (bound <40). Original packaged bytes were restored, then rebuilt. Direct code/test/spec review found no unresolved in-scope defect. No commit was created.

Limits: synthetic covers, one machine/display scale, two cover traversals and five reader reopen cycles; partial cache eviction rather than a post-boot cold start. No extracted-cover generation, very long-session memory proof or final visual design is claimed. M3-06 and milestone-four import remain separate work.

## Visual direction applied (M3-06)

Done on 2026-11-04. A throwaway browser prototype (simulated data, no catalog) showed three structurally different directions for the library window and reader controls:

- A, "Reading room": serif type on warm paper, covers at their real proportions, folded filters and a faint bottom bar in the reader.
- B, "Catalog": dense sans type, a dark index sidebar, status chips and a full reader toolbar.
- C, "Workbench": three panes with a details inspector and a reader side rail.

Each was checked in light and dark for the library, a no-match search, an empty library and PDF/EPUB readers. The user chose **A for both the library and the reader**. The spec's "Visual direction" paragraph records the choice. The prototype was then removed, along with its dev script and lint override; it was never part of a build.

Applied to the application:

- `library.css`: palette, P052 serif interface type and shelf-aligned covers. Placeholders get a dashed box; images keep their own proportions (`Cover` now marks `has-image`).
- Library window: one rounded search field. A Filters disclosure holds author, subject and Include archived; it floats over the results and its summary counts active filters. Escape folds it and returns focus to the summary.
- Selection: checkboxes appear on hover, focus, when checked or while selecting. A selection bar floats at the bottom, keeping its position before the results in Tab order.
- `ContinueReading`: up to six unarchived Currently Reading books, most recently opened first. It is shown only for All Books in grid layout without search or filters, and is built from the already-loaded results, so it adds no query and reads no cover files in List mode.
- Catalog reader windows now fill the window. A quiet small-caps title line holds the save state and the Open library / Quit actions; alerts and the restoration notice float over the page. Diagnostic fixture readers keep the diagnostic shell.
- Content frame: the book fills the frame and the controls sit in a bottom bar at 70% opacity (above 4.5:1 text contrast at rest), fully visible on hover or focus. Search shows `/` and Jump shows `:` hints, which are `aria-hidden` so accessible names are unchanged. In-book search floats over the page, the Ready status is visually hidden once announced, and catalog books hide the diagnostic snapshot tools. The reading surface keeps `color-scheme: light`, so EPUB pages keep their authored colours in dark mode. Under 640 px the bar stacks.

Two regressions found during verification and fixed:

1. **Alerts resized the book.** A shell alert in flow shrank the now-flexible book frame. The resulting repagination produced a genuine position report after the A14 test's forged sequence-999 write, so it failed 5/5 (`out-of-order` instead of `invalid`). Messages now overlay the page; the case passes.
2. **PDF fit/redraw loop (latent adapter bug exposed by the new geometry).** `PdfSession` computed the fit from the surface's client area, which shrinks when a zoomed page adds a scrollbar. At the test geometry the surface alternated between 285 and 270 px and redrew about 60 times per second. The final text assertion then failed intermittently (3/12, versus 12/12 passes before the layout change). The fit now uses the surface's outer box. `#surface` also has `contain: size`, so a zoomed page cannot widen the bar's grid column. A new assertion in the PDF fit/zoom case requires zero redraws during 600 ms after restoration. It fails the old adapter 12/12 (35–36 redraws) and passes 12/12 with the fix.

Native tests: `library-window.spec.ts` now opens Filters where needed and expects the new Tab order (Filters before Author). It also covers the strip: present only in grid All Books without narrowing, order by most recent open, books remain in results. It covers the active-filter summary and Escape.

Verification: `mise run check` passes (199 unit cases). `smoke` passes 46 native cases and `smoke-packaged` 10. A fresh-seeded `mise run measure` passes all three cases and every unchanged budget (`dist/measurements/m3-06-seeded-final.json`, 6.9 minutes):

- Warm cover-ready launch takes 798 ms median and evicted 3.12 s. Launches read 9 cover files, down from 32 because larger covers mean fewer cards per screen, and no book files.
- Full browsing reads exactly 343 live covers, at 597/690 MiB PSS after one and two traversals.
- Reader opens take 560 ms (PDF) and 634 ms (EPUB) median. Saves are acknowledged in at most 399 ms (PDF) and 825 ms (EPUB).
- Two readers after search use 590 MiB.

Real-window screenshots of the 500-book template (light and dark, selection, filters, PDF search, narrow EPUB window) were inspected.

Limits: fonts are installed system fonts (P052 comes from the URW base-35 set); another machine falls back to Palatino-like or generic serif. Reading-progress percentages are not shown, because no stored page count exists yet. EPUB dark-mode theming was deliberately not done. Visual QA was one display at scale 1. No commit was created.

## Batch file/folder import (M4-01)

Done on 2026-11-04. The library window imports through main's chooser: **Import files…** (multiple PDF/EPUB files, with an "All files" filter so other files can be chosen and explained) and **Import folder…** (one or more folders). Both buttons sit on the view-title line; in a selected section they import into it, elsewhere into Unfiled. Trash has no import.

- `src/library/import-batch.ts` walks the selection and imports each file through `addFileAsNewBook` sequentially (the bounded-parallelism choice). Per-file outcomes are imported, skipped, unsupported, failed or cancelled, with reasons. Walking: ordinary subdirectories in name order; links to folders are reported and not followed; links to files are read; FIFOs and other special files are reported and never opened blocking (sources open with `O_NONBLOCK`); the library root is reported and not scanned; each device/inode is processed once.
- `src/library/import.ts`: byte-identical live content (archived included) is skipped after staging and before publication, naming the existing entry. Candidates come from SHA-256 and size and are compared byte for byte, and the commit transaction rechecks the hash for a concurrent duplicate. The target-section membership is inserted in the book's commit. An `AbortSignal` cancels at any protocol point before the commit and the current copy is rolled back.
- `src/main/library-ipc.ts`: `library:import`, `library:cancel-import`, and `library:import-progress` events. One batch at a time. Destroying or reloading the starting page cancels the batch, including while the chooser is open. `BORGES_IMPORT_CHUNK_DELAY_MS` (unpackaged builds only) slows copying so native tests can cancel deterministically.
- UI: `ImportControls.tsx` shows "Importing N of M: name" with **Cancel import**, then a dismissable summary. It has counts, a note on where new books went, grouped outcome lists (groups with more than 10 entries start folded) and **Show “title”** for skipped duplicates, which opens All Books or Archive searched for that title. The empty library now points to the import buttons.

Unit evidence (`tests/unit/import-batch.test.ts`, 14 cases, real files and catalogs): a mixed nested folder with a linked folder, a linked file outside the folder, a FIFO, a text file, a mislabelled PDF and a truncated EPUB, with exact outcome order/messages/progress, Unread/unfiled books and unchanged source hashes; identical content across and within batches, including archived (the duplicate never reaches publication); two concurrent identical imports commit once; section joins, a section deleted mid-import and an unknown section; cancellation at copying and at published; independent unreadable/missing/FIFO/injected `ENOSPC` failures; the library folder and links into it; overlapping selections; invalid selections; explicitly selected file links. Mutations that fail tests: no in-commit recheck, no pre-publication check, archived books excluded, no section insert, directory links followed, library folder scanned, no once-per-file check, and cancellation checked only before copying. The pre-publication mutation first exposed a real leak: the in-commit duplicate carried the managed `path` into the outcome sent to the renderer. Outcomes now carry only ID, title and Archive flag.

Native evidence (`tests/e2e/library-import.spec.ts`, 2 cases, chooser stubbed at the dialog-result boundary): a mixed folder imports 3 books and reports 2 unsupported through the UI, with source hashes unchanged and staging empty. The imported PDF and fixed-layout EPUB render known text and the EPUB's coral image. Reader windows are refused both channels. An identical reimport of an archived book is skipped and **Show** finds it in Archive. Importing from a selected section joins it. With paced copying: Cancel during the second of five files keeps one book and rolls back the copy; reloading the library during a copy cancels it in main; reloading while the chooser is open starts nothing; a later batch works. Native mutations that fail: reload not cancelling, the UI not passing the section, and listeners attached after the chooser.

Review found and fixed two more issues. Wrapped toolbar buttons pushed Filters onto a second line, and its right-anchored panel spilled under the sidebar, which `library-window.spec.ts` caught as a 30 s timeout; a screenshot confirmed it, and the buttons moved to the title line. A reload during the chooser was not cancelled. Two existing suites seeded 130 copies of identical bytes; their seeds now differ by a placeholder comment, because identical content is now correctly skipped.

Verification: `mise run check` passes (213 unit cases), `smoke` 48 native cases, `smoke-packaged` 10. Real-window screenshots of the Filters panel and an import summary were inspected (light, one display at scale 1). A fresh-seeded `mise run measure` passes all three cases and every unchanged budget (`dist/measurements/m4-01-seeded.json`, 6.8 minutes). Its 500-book seeding goes through the changed import path; all generated documents are distinct, so none were skipped. Medians: warm cover-ready launch 811 ms, evicted 3.18 s; catalog queries 1–6 ms; reader opens 588 ms (PDF and EPUB); saves acknowledged in at most 423 ms (PDF) and 794 ms (EPUB); two readers after search 602 MiB PSS; full cover browsing 584/652 MiB.

Not covered: metadata/cover extraction and PDF/EPUB parse, encryption and DRM checks (M4-02; a well-formed container that PDF.js or foliate-js cannot open is still imported), metadata-duplicate choices (M4-04) and Trash-only hash matches (M4-06). Physical chooser interaction is not automated. Imports run on the main process's event loop with async I/O; only the small SQLite statements are synchronous. Power-loss durability is not tested.

## Content validation and extraction (M4-02)

Done on 2026-11-04. Final code/test/requirements review found no unresolved M4-02 defect; the earlier intermittent reader-opening timeouts below remain unexplained. No commit was created.

The library's import path now passes the staged copy to `createBookInspector`. Main owns file/catalog operations; the inspector uses a hidden, sandboxed renderer with no preload or assigned application-window identity, a dedicated nonpersistent session and origin, and access to bundled parser assets plus exactly one approved staged file. Each job gets a new sandboxed window in a renderer separate from open readers; the window is destroyed on success, failure, cancellation or watchdog refusal. The session is reused between jobs. There is no runtime network dependency, new package or schema migration.

- PDF.js validates every physical page's operator list. Password-protected and empty-password encrypted PDFs are refused. Available XMP/Info title, ordered authors and subjects/keywords are extracted; page one supplies a raster cover.
- EPUB container/package/spine XML is parsed detached from any document surface using the pinned ZIP reader and Chromium's XML parser. EPUB 2/3 declared PNG/JPEG covers are decoded to thumbnails. AES/other encryption and font-obfuscation declarations applied to nonfonts are refused; ordinary IDPF/Adobe font obfuscation is permitted. Ordinary external XHTML doctypes are accepted without fetching DTDs; entity declarations are refused. No book script, style or chapter element is mounted in the inspector.
- Optional fields use independent validation and fallbacks. A missing title uses the filename; authors stay ordered; subject labels are deduplicated ignoring case while keeping the first spelling. Invalid optional fields warn without discarding other fields. A failed cover decode, including a renderer crash or watchdog overrun after content validation, warns and keeps the book with a placeholder. Cancellation still aborts the current book.
- `revisions.extracted_*` and effective book/author/subject values commit with manual flags clear. Extracted cover publication uses a paired `cover` operation; both operation states and both references commit with the book. Failed transactions roll both publications back. Later manual corrections preserve the revision's extracted values.
- Budgets are recorded in the spec: 256 MiB input, 30 seconds, a 512 MiB renderer working-set watchdog sampled every 250 ms; bounded ZIP expansion/XML, PDF page/operator counts and raster dimensions. This is a sampled watchdog, not a kernel-enforced memory ceiling. An individual budget refusal explains the reason and preserves the source.

Tests and review:

- The two initial storage tests failed against the old implementation (filename-only metadata and absent warnings), then passed. The 13 cases in `tests/unit/import-extraction.test.ts` cover metadata/order/normalization/provenance, warning delivery, validation rejection, catalog rollback, cover storage failure, cancellation after cover publication and seven real process kills (four cover stages, published book, open catalog transaction, immediately after commit). Before commit, startup removes both verified publications; after commit, it preserves the book and cover. Existing protocol tests intentionally isolate storage and omit the inspector; production library IPC requires it.
- Six native cases in `tests/e2e/library-extraction.spec.ts` cover A1 through a mixed-folder import with unchanged source hashes, extracted PDF/EPUB fields and decoded covers, metadata search, successful readers (including missing metadata), independent protected/corrupt/oversized failures and warnings. Real parser CPU hangs, 600 MiB allocation pressure and a cover-renderer crash are injected at the execution boundary. The parser PID differs from every existing reader frame's PID; main-backed queries and reader page turns continue. Cancel, timeout and memory refusal dispose the job, leave no entry/partial files, and allow a later import. The failure cases also require the parser PID to disappear from Electron process metrics. The cover crash imports with a warning. A separate case proves absent Node/host bridges, blocked external/file/app/traversal fetches, no book-script execution and denied popups.
- The new relocated-package case imports/extracts without source modules or a development server, refuses a protected PDF, restarts with decoded covers and manual/extracted provenance intact, and opens the metadata-free EPUB. The native file chooser is stubbed at the dialog-result boundary.
- Native testing reproduced a pinned-foliate failure on entirely empty descriptive metadata (`Object.groupBy called on null or undefined`). `readablePackage` in the EPUB adapter now supplies only an unknown-language element to its in-memory package when no Dublin Core elements exist. The real reader regression check passes; imported and source bytes stay unchanged. Review reproduced a malformed-spine-media-type import that should have failed (7 successes instead of 6 in the mixed-folder case); supported spine media types are now checked before parsing chapters. Review also changed XML handling to allow normal doctypes while refusing entity declarations, and reused one inspector session to avoid retaining a session per imported book.
- A first packaged run had 10/11 passes: an existing diagnostic reader stayed at Opening past its unchanged five-second wait while `check` was also running. Its cause was not established. The serial rerun passes all 11 cases with unchanged assertions. A later native run had 53/54 passes with the same Opening timeout in the existing corrupt-PDF/healthy-EPUB case. Five focused repetitions passed. Its cause and relationship to the adapter change were not established; no timing assertion was weakened. A traced rerun was interrupted when the desktop session changed; the subsequent full serial run passes all 54 cases. Builds/checks and native suites must remain serial as documented above.


Final verification: `mise run check` passes types, Biome, 226 unit cases and the production build. Full `mise run smoke` passes 54 native cases; after the final spine-media-type guard, all six extraction cases pass again, including actual parser-PID disposal. Final `mise run smoke-packaged` passes 11 cases. The fresh-seeded `mise run measure` passes all three cases and every unchanged budget (`dist/measurements/m4-02-seeded.json`, 7.4 minutes including 298 seconds seeding 500 books/400 covers). The final guard changes only import inspection, which these controlled catalog seeds intentionally omit; it does not change the measured startup/browsing/reader flows. Observed on this machine:

- Warm cover-ready launch: 945 ms median; evicted cover-ready launch: at most 3.78 s. Launches read nine covers and no book files.
- Catalog query p95: at most 8.9 ms, with two-reader queries at most 8.4 ms.
- First PDF/EPUB open: 745/700 ms; resumed medians: 591/582 ms. Position acknowledgements: at most 367/335 ms.
- Two readers after search: 614 MiB PSS; full cover browsing: 606/701 MiB after one/two traversals.

Limits: the created fixture corpus and one Arch/Hyprland display at scale 1; no broad external-book corpus, hard OS memory containment or power-loss proof. A missing or unusable raster cover uses the placeholder; SVG/HTML cover rasterization is not implemented. Physical chooser interaction is not automated. Metadata-duplicate choices, replacement and Trash remain M4-03 onward. Publication-only catalog seeds do not exercise content inspection, so 500-book measurements establish browsing/startup/reader budgets rather than extraction throughput.

## Manual Replace File (M4-03)

Implemented on 2026-11-04 without dependency or schema changes. One selected book has **Replace File…** with a confirmation explaining the position reset, preserved organization/manual details and retained previous revision. Main's library-only chooser accepts a PDF or EPUB; the same bounded sandboxed inspector used for import validates the staged copy before any reader session is stopped. Import and replacement cannot overlap, and closing/reloading the starting library page cancels uncommitted work, including an open chooser.

`replaceBookFile` reuses immutable book/cover publication with a `replace` recovery record. Its final transaction rechecks the selected revision, inserts the new revision/extracted fields, switches the same book, refreshes available nonmanual metadata, retires the old revision, records its revision Trash entry, advances the session generation and commits both publication records. Sections, reading status, Archive, intentional manual clears and manual covers are preserved. Missing extracted values retain useful old effective metadata. The new revision starts without a position; old revision-specific position and bytes stay at their existing paths. EPUB font sizing is cleared across formats; fixed-page zoom remains available, with adapters applying only applicable sizing.

An open reader continues working while the copy is validated and published. Immediately before the synchronous catalog switch, `ReaderSessions.quiesce` commits its pending position and retires its durable session generation. A failed save or retirement stops replacement and preserves the session for retry. A subsequent transaction failure reloads the unchanged revision; success reloads the existing window with the new title/revision at the beginning. Late old-generation/revision reports are rejected. A shell-reload failure after commit is a warning alongside replacement success; the catalog switch and old Trash revision remain committed. The warning explains closing/reopening the reader; ordinary reopening otherwise focuses its existing window. Engine loading errors appear in the reader.

Recovery rolls back only the replacement's own verified staged/published files before commit. It checks candidate revision/path references without mistaking the existing target book for a reference to the new copy. Changed bytes, catalog references or paths not belonging to the operation are retained and reported; uncertain artifacts are never silently removed. After commit, both new current state and old Trash state remain. There is no purge in this task.

Tests and review:

- The initial cross-format replacement case and strict-session-flush case failed against absent behavior, then passed. `tests/unit/replacement.test.ts` has 20 real-storage cases: book identity/sections/status/Archive, manual clears and covers, extracted/effective metadata and absent-value fallbacks, compatible sizing/new-position reset, stale writes, independent precommit failures, cancellation, changed-target refusal, other-live duplicates (archived included), uncertain-artifact preservation and seven real process kills (pending, copying, cover pending, cover rename, published book, inside the catalog transaction, after commit). Precommit kills keep the old revision/location and remove only verified new artifacts; the postcommit kill keeps the new book/cover and old revision Trash entry. The two additional session cases cover failed flush and failed durable retirement with retries.
- Review caught the import duplicate check refusing replacement from an identical original when the managed copy was missing. Two new cases reproduced that rejection. Replacement now excludes its own target from both duplicate checks, while import keeps its existing skip behavior and another live entry still blocks replacement. Explicitly recopying the same target makes a new revision with a reset position. The spec records this delegated default; a native case repairs a missing managed PDF and reloads its previously failed reader.
- Five native cases in `tests/e2e/library-replacement.spec.ts` cover A9 (including a deliberately long autosave interval proving replacement flushes page 3), PDF↔EPUB replacement, preserved manual metadata/status/Archive/sections, extracted metadata/cover, known first EPUB text, unchanged source/old managed bytes, late-write and reader-sender rejection, process restart, protected/corrupt refusals, chooser cancellation, extraction fallbacks, real SQLite save/switch failures with a usable old reader, a postcommit reload failure, mutually exclusive operations and chooser cancellation on library reload.
- The existing relocated-package reader case now replaces its resumed PDF with an EPUB, verifies the old page in Trash and opens the replacement after another real restart. Inspection, publication and reader loading use the relocated offline bundle.
- Four temporary mutations fail focused tests: overwrite a manual title, omit the old revision's Trash entry, ignore a failed reader flush, and disable replacement rollback. Each source was restored before final checks. Direct review included tracked changes and the new implementation/test files. It also scoped floating-selection-bar styles to direct children so nested confirmation paragraphs/buttons retain normal dialog styling; native screenshots were inspected.

Final verification: `mise run check` passes strict types, Biome, 248 unit cases and build. Full serial `mise run smoke` passes all 59 native cases; `mise run smoke-packaged` passes all 11 relocated-runtime cases, including the extended reader replacement/restart case. Direct requirements/code/test review found no unresolved in-scope defect.

Limits: the native file chooser is stubbed at its result boundary; the created fixture corpus and one Arch/Hyprland display at scale 1 are covered. Process kills test recovery, not physical power-loss durability. No A13 remeasurement was run for this task: replacement adds no startup/browsing work beyond its reconciliation branch; the milestone-four acceptance gate retains the conditional remeasurement. Trash browsing, restore and purge remain M4-05 to M4-07; the earlier revision is durably accounted for now. No commit was created.


## Metadata-duplicate import choices (M4-04)

Imports with matching extracted title and a shared author now pause for Keep Both, Replace selected, Skip or Cancel import. The Reading room dialog lists every live candidate, including Archive, with authors, format and original filename; replacement requires a radio selection and explains the position reset and previous revision retention. Candidates remain scrollable in small windows. The native chooser result alone is stubbed in Electron tests; extraction, publication, SQLite, IPC, reader sessions and reloads are real.

Verification: `mise run check` passes TypeScript, Biome, 262 unit cases and the build. Eleven added batch cases cover explicit choice, normalization, all/archived candidates, absent title/author and punctuation boundaries, selected-target replacement, cancellation, unknown/stale target and reader flush refusal. Three new real child-process kills verify rollback while waiting for a choice and after adopting a replacement target (before cover publication), and retention after commit. Four new native scenarios pass for Keep Both/section membership, identical skip, specific open-reader replacement with old page flushed to Trash, Skip/Cancel, expired-token refusal, and cancellation/retry after reloading a pending prompt. The dialog screenshot was visually inspected. Full serial `mise run smoke` passes 62 cases; the subsequently added reload regression and all three original metadata-choice scenarios pass in a focused four-case run. `mise run smoke-packaged` passes all 11 relocated-runtime cases. Direct requirements/code/test review found no unresolved in-scope defect. Native choosers are stubbed at their result boundary; the duplicate-choice dialog itself is exercised.

No schema/dependency change. Existing manual-replacement kill tests protect the shared publication protocol; power loss remains untested. Trash-only hash choices, browsing, restore and purge remain M4-05 to M4-07. A13 was not remeasured; the milestone-four acceptance gate retains conditional remeasurement.

## Delete to Trash, browsing and deleted-book restore (M4-05)

Selected library books now offer Move to Trash with a recoverability/reader-close explanation. Each open reader must save and retire successfully, and its window must actually close before the book is soft-deleted. The Trash view follows the Reading room styling and shows deleted books, superseded files, dates, saved locations and the unique readable file/cover bytes referenced by those entries. Deleted-book restore preserves metadata/manual provenance, status/Archive, position and sizing. It restores surviving section memberships, names missing sections, and explains Unfiled/Archive outcomes. Missing files remain cataloged and restore with a visible Replace File repair warning. Identical-live-content restore conflicts preserve Trash and show the existing book.

Verification: `mise run check` passes types, Biome, 273 unit cases and the production build. Eleven new storage cases cover state/membership restoration, failed transactions, identical-live conflicts, Unfiled and stale/damaged context, missing files, revision listing/cover accounting, and four real process kills before/after delete/restore commits. Six focused native Electron scenarios pass: actual reader flush/close/resume, cancellation, missing section explanation, superseded locations, save/close/catalog refusal, partial selected-book deletion, rejection of competing actions/session reacquisition while a reader closes, and an identical-live restore conflict that opens the existing entry and retains its explanation after refresh. The Trash screenshot was visually inspected. Review fixed action errors being erased by successful catalog refresh and blocked competing mutations during close. Full serial `mise run smoke` passes 68 cases. After the final conflict-message review fix, all six Trash cases pass. `mise run smoke-packaged` passes 12 cases, including a new deletion/restart/restore/restart/reader-resume scenario in the relocated artifact. Direct requirements/code/test review found no unresolved in-scope defect. The restore-conflict regression was observed failing before its fix and passing afterward.

No schema/dependency change or file move/deletion is involved. SQLite crash recovery protects these catalog-only transitions; this is not power-loss testing. Byte totals count referenced file lengths once and exclude missing files, recovery artifacts and unreferenced covers; they do not promise reclaimable disk space. Revision restore, Trash-only import matches and purge remain M4-06/M4-07. No A13 remeasurement was run here: Trash enumeration runs only on entering/refreshing Trash; milestone-four acceptance retains the conditional measurement gate.

## Revision restore and Trash-only import matches (M4-06)

Superseded files now offer Restore as current and Restore as separate book, each with a confirmation explaining state/position and Trash retention. Current restore verifies the stored digest, preserves organization/status/Archive/manual metadata, recovers the original locator, moves the displaced revision to Trash and reloads an open reader after strict save/retirement. Separate restore copies retained bytes into an independent Unread/unfiled entry with extracted metadata and initial position; the original revision and location remain recoverable in Trash. A deleted owner must first be restored before switching its current file.

New-book imports with a Trash-only hash show all matching entries and offer restoring the deleted book, restoring a superseded current file where available, using a separate Unread copy, canceling this file or canceling the batch. The summary reports restored/reused outcomes. Existing-live equality retains precedence, including Archive. Live conflicts are explained and open/activate the existing entry. Native choosers are stubbed at their result boundary; publication, hashing, SQLite, reader reload/resume, and the choice/confirmation dialogs are real.

Verification: `mise run check` passes types, Biome, 292 unit cases and build. Nineteen new storage cases cover original-locator recovery, independent copy/manual metadata separation, missing/modified bytes, save/commit/stale-target refusal, deleted owners, import choices/cancellation, and five SIGKILL points (current commit before/after, separate publication before/after, and a pending import choice). Full serial `mise run smoke` passes all 74 native cases, including five new revision/import scenarios and the updated existing Trash conflict scenario. Native cases verify current-reader restoration, separate Unread copying, live conflicts, Trash-only current/deleted restore choices, cancellation/reload, failed saves and committed reload warnings. `mise run smoke-packaged` passes all 13 relocated-runtime cases, including Trash-only import restoration and saved-page resume across separate process restarts. Direct requirements/code/test review found no unresolved in-scope defect. Restore confirmation screenshots were visually inspected. Review added the cancellation signal to deleted-book import restoration and placed the separate-copy source snapshot check inside the publication transaction.

No schema/dependency change. File bytes are never moved or removed by restoration; independent copies use existing crash-safe publication. Process kills do not establish power-loss durability. Restore of a missing deleted-book file restores only its catalog entry with an explicit Replace File warning; damaged/missing superseded bytes are refused and kept. Empty Trash remains M4-07; broader acceptance and conditional A13 remeasurement remain M4-08.

## Empty Trash and purge recovery (M4-07)

The Trash view now offers Empty Trash with a modal showing entry count and retained file/cover storage. Cancel preserves all bytes. Main refuses a stale entry/storage snapshot and other senders. Confirmed removal is serialized against other library mutations and an open cover chooser. A deleted book and its revisions purge as one group; each superseded revision of a live book is independent. Current live revisions, shared covers, sources and unrecognized managed files are protected.

A `purge` operation records its catalog-owned paths/digests before the first unlink. Files must be regular, under canonical managed directories and match their recorded size/SHA-256. Each removal syncs its directory; missing files in an existing confirmed purge are treated as interrupted removals. The final catalog transaction removes only the planned Trash/revision/book state and marks the purge committed. Failures retain the Trash rows and a durable explanation, block restoration of that owning book's affected content, and can be retried with Empty Trash or by the next startup. Superseded cover publications of a deleted book are also eligible, while covers referenced elsewhere stay. Completed cover removals are recorded in publication history so a later deletion does not show intentionally purged covers as missing.

Verification: `mise run check` passes types, Biome, 312 unit cases and build. Twenty new storage cases cover deleted groups, independent retired revisions, shared covers and live positions, superseded covers, unknown files, real permission failures, modified bytes, final/directory symlinks, stale confirmation, changed catalog ownership, failed intent/final-commit writes, missing files and five SIGKILL points (recorded intent, first unlink, all file/cover removals, final transaction and postcommit). Three temporary mutations (disable shared-cover protection, skip digest checking, allow restoration during an unfinished purge) fail the focused tests; sources were restored. The false-missing-cover regression and independently pending shared-cover purges were reproduced before their fixes.

A clean full serial `mise run smoke` passes all 77 native cases, including three new purge scenarios. After the final cover bookkeeping/layout correction, the 11-case native cover/Trash/purge suites also pass. They verify the real confirmation and Cancel, an open current reader and source preservation, reader sender denial, persistent partial failure/repair/retry, stale count/storage refusal, and actual Electron startup completion after a failed final commit. The confirmation screenshot was visually inspected. An earlier full native run overlapped a rebuild and was discarded; the clean full run above had no concurrent build. `mise run smoke-packaged` passes all 14 relocated-runtime cases, including failed purge final commit followed by startup continuation with live/source bytes preserved. Direct review found no unresolved in-scope defect.

Direct implementation/requirements/test review fixed the intentionally removed-cover accounting and verified that multiple pending purges remain retryable when another purge removes a previously shared cover. No schema/dependency change. Process kills do not prove physical power-loss durability. No A13 remeasurement in this task: normal browsing/startup do no new book/cover reads; extra enumeration runs only in Trash and reconciliation handles confirmed interrupted work. M4-08 retains broader milestone acceptance, copied-root checks and its conditional measurement gate. No commit was created.

## Milestone-four acceptance (M4-08)

Completed on 2026-11-05. This gate audits the implemented import/Trash workflows against A1 and A8–A12, adds the populated copied-root scenario missing from the earlier relocation check, and reruns A13 with the unchanged cover-bearing budgets. No application, schema, dependency or compositor-policy change was needed.

| Requirement | Executable evidence |
| --- | --- |
| A1 | `library-extraction.spec.ts` imports a mixed folder, preserves every source digest, checks metadata/cover fallbacks and individual protected/corrupt failures, and renders known PDF/EPUB content; `readers.spec.ts` checks decoded PDF pixels and EPUB images/fonts. |
| A8 | `library-import.spec.ts` and `library-duplicates.spec.ts` exercise identical skips, every metadata choice, Keep Both membership, explicit replacement targets, stale prompts and cancellation. |
| A9 | `library-replacement.spec.ts` verifies an open-reader cross-format replacement, preserved organization/status/Archive/manual edits, old page/bytes in Trash, reset current position and rejection of late writes. |
| A10 | `library-trash.spec.ts`, `revision-restore.spec.ts` and `library-purge.spec.ts` exercise deletion/restore, missing sections, separate/current revision restore, live-content conflicts, confirmation, partial purge/retry, and live/shared/source protection. |
| A11 | The real-storage import/extraction/replacement/Trash/revision/purge unit suites inject copy/parse/database/save failures and SIGKILL real child processes around publication and commit. Reopened catalogs retain either the prior state or the completed operation, with tracked/verified leftovers. Native tests cover reader save/close/reload refusal and packaged startup completes an interrupted purge. |
| A12 | The new `tests/packaged/runtime.spec.ts` populated-backup case uses actual import, manual edits/cover, nested membership, saved PDF/EPUB positions and sizing, Finished/Archive, replacement and deleted-book Trash. It closes every window, copies the whole root, renames the original root and sources out of their recorded paths, and launches the copy with a fresh profile. The copied runtime renders the saved EPUB passage and manual cover, restores the old PDF page and deleted book, purges only the displaced EPUB, and retains the result through another process restart. The original catalog remains byte-identical and independently opens with its earlier Archive/Trash state; sources remain byte-identical. Existing catalog tests cover migration rollback and byte-preserving newer-schema refusal; packaged tests cover schema upgrades/refusals. |

The backup test waits for reader initialization and committed sizing before copying; rendered chapter text can appear before initialization restores the saved settings. Its first iterations attempted to change the font during initialization and observed the initial size instead. Waiting for `Ready` and checking the committed input corrects that test setup. This scenario establishes closed-folder backup of committed data, not window-close behavior during an in-flight sizing operation.

Verification: `mise run check` passes types, Biome, 312 unit cases and the production build. The clean full serial `mise run smoke` passes 77 native cases; `mise run smoke-packaged` passes all 15 relocated-runtime cases, including the new populated-backup scenario. Direct requirements/code/test review found no unresolved in-scope defect. The fresh-seeded run took 259 s to publish the 500 books/400 covers and passed launch and full-grid cover cases, but the two-reader case exceeded PDF resumed-open (1691 ms versus 1500 ms) and EPUB full-search (1131 ms versus 1000 ms) budgets. All other soft budget assertions passed. Its report is `dist/measurements/m4-08-seeded-overruns.json`. A process/load inspection immediately afterwards showed unrelated C++ compilations saturating the six CPU cores (load average 6.51); contention is a plausible cause, not a proven attribution. Those processes were left alone. After those compilations ended, a full prebuilt-cover-catalog rerun against the same artifact passed all three cases and every unchanged budget in 2.2 minutes. Its report is `dist/measurements/m4-08-prebuilt-final.json`. It copied `dist/a13-covers-template`, identified as prebuilt in the report; the first run used a fresh seed. No cause was conclusively isolated and no threshold or runtime code was changed. Final types/Biome and `git diff --check` also pass. No commit was created. The created fixture corpus, chooser-result stubbing, one Arch/Hyprland display and process-kill rather than power-loss limits from the preceding evidence continue to apply. The completed product still requires milestones five and six.


Final A13 rerun on the same i5-9400/UHD 630, 11.5 GiB, home HDD/btrfs and Hyprland 1920×1080 scale-1 session, with Electron 45.2.1/Node 24.22.1:

| Measure | Observed | Unchanged budget |
| --- | --- | --- |
| Warm catalog / visible-cover launch, median | 948 / 1105 ms | 1500 / 2000 ms |
| Evicted launch with visible covers, max | 3634 ms | 8000 ms |
| Idle / two-reader catalog query p95, max | 9.4 / 7.3 ms | 50 ms |
| PDF / EPUB first-or-resumed open, max | 1177 / 687 ms | 1500 ms |
| PDF resumed open, max | 658 ms | 1500 ms |
| EPUB full search, max | 230 ms | 1000 ms |
| Position acknowledgement, max | 386 ms | 1000 ms |
| Idle / two-reader total PSS after search | 329 / 613 MiB | 400 / 800 MiB |
| One / two complete cover traversals, PSS | 631 / 716 MiB | 1600 MiB |

Launches read zero book files and nine covers; the reader case reads exactly its two opened book files. Full browsing reads exactly the 343 unarchived covers, with four peak decodes and fourteen peak live URLs; List releases all URLs. The final rerun verifies the same bounded-loading/disposal contracts as M3-08. These are machine-specific measurements with partial cache eviction and short sessions; the initial overruns remain part of the evidence, not a guarantee of timing under competing system load.

## Integrated reader controls and search (M5-01)

Milestone five was audited against the existing spike/catalog evidence and split into bounded tasks in the implementation handoff. This first task completes the shared reader control/search behavior while retaining the Reading room appearance and the existing engine/host separation.

Reopening search now reruns its retained query, restoring incremental results instead of leaving a stale match count beside an empty list. PDF redraws rebuild the active match range in the new text layer after zoom, fit or resize; closing/changing search and explicit navigation still remove it. Reader shortcuts leave focused publisher lists and dialogs alone, as well as the existing inputs/buttons/links. Contents resets to its navigation prompt after a selection, so the same destination can be chosen again after a search, jump or page turn.

Three new native catalog-reader cases use the known PDF markers, two literal lantern offsets per page, the image-only PDF and LANTERN PASSAGE 24. A small created EPUB variant adds ordinary focusable list/dialog markup without scripts. The checks cover catalog navigation boundaries, invalid jumps, outline reuse, button Tab/Enter behavior, search reopening and forward/backward traversal, query replacement, text absence, zoom/pan confined to one PDF page, connected highlighted text after actual redraws, EPUB chapter/percentage controls, passage retention through font/viewport changes and focus restoration. The 600×420 content viewport retains every visible control; its screenshot was visually inspected. This is a controlled content-frame viewport, not coverage of other native display scales/backends. The existing diagnostic gates continue to cover fixed-layout/images/fonts and broader keyboard/locator behavior.

The initial native cases reproduced detached PDF highlighting, empty reopened search results and consumed publisher-list keys before the fixes. Review added and reproduced the repeated-Contents regression before correcting it. A test-setup timeout while panning over the open search overlay was resolved by moving the pointer onto the exposed reading surface; application assertions were retained.

Verification: `mise run check` passes strict types, Biome, all 312 unit cases and the production build. The clean full serial `mise run smoke` passes all 80 native cases, including the three new catalog-control cases and the existing reader/isolation/session/replacement/window gates. `mise run smoke-packaged` passes all 15 relocated-runtime cases. Direct review covered requirements, the final adapter/control changes, new tests/fixture/generator and affected documents, including untracked files; no unresolved in-scope finding remains. No schema, dependency, privilege or compositor change. A13 was not rerun: search scanning, process allocation and book/cover loading are unchanged; active-match reconstruction scans only the rendered PDF page. M5-02 to M5-05 retain external Copy Link, a broader corpus, save/load recovery, crash containment and full reader acceptance. No commit was created.

## Links and reader corpus (M5-02)

External PDF URI annotations and EPUB references now offer a trusted-shell address dialog with an explicit **Copy Link** button. Selecting/dismissing a reference does not write the clipboard, launch a browser, create a window or fetch its target. Ordinary HTTP/HTTPS, mail, telephone and FTP addresses are bounded/validated in the adapter/shell/main path; protocol-relative addresses use HTTPS. Main permits only registered reader main frames to call the clipboard-write endpoint. Book/engine frames receive no clipboard bridge/read access or new permission. Local/app/script/data addresses remain blocked. The Reading room dialog floats above the book without changing its viewport or repaginating it.

The created CC0 corpus now adds four PDF page geometries (portrait/landscape/rotated/cropped), named destinations/URI annotations, nested percent-encoded EPUB chapter paths, same-chapter footnotes/return links, cross-chapter fragments, Unicode selection, SVG/raster illustrations, obfuscated local fonts and an EPUB 2/NCX/RTL variant. Existing fixed-layout EPUB remains single page through fit/zoom/pan and viewport changes. Real mouse text selection followed by native Ctrl+C is checked against independent literal text and Electron clipboard contents for PDF and EPUB. The new small corpus also passes the actual bounded import inspector, with source hashes unchanged (the native file chooser is stubbed at its result boundary). The existing deterministic book-length generators supply a 400-page/211k-word PDF and 40-chapter/120k-word EPUB; catalog readers search the whole book for the single known late `quartzfinal` passage, navigate to page 397/chapter 38 and retain it after sizing.

The internal-link case reproduced a real foliate focus race: its next-animation-frame source-link scroll can run after destination navigation and jump back. An earlier explicit Contents/search anchor could also be restored by a later resize. Clicked internal destinations now go through the engine's command queue after two animation frames, using the normal format-specific restore path; this replaces the explicit anchor. No vendored source was changed. The footnote/return/cross-chapter/font/resize scenario failed before this fix and passes with it. Test development also corrected a cropped-page fixture expectation, waited for a complete canvas across redraws, and accessed the fixed-layout renderer through its public view property (its shadow DOM is closed).

Verification: `mise run check` passes types, Biome, 330 unit cases and build (18 new URL-policy cases). The clean full serial `mise run smoke` passes all 89 native cases, including nine new corpus/import/link cases and the existing adversarial/resource/session gates; `mise run smoke-packaged` passes all 15 relocated-runtime cases. The two external-reference cases fail with the original adapters restored (missing PDF reference control / missing EPUB dialog), and removing only the shell's source-window check fails the forged-chapter-message case. Direct review covered requirements, the final shared URL policy/IPC/shell/adapter changes, new tests/generator/fixtures including untracked files, and affected documents; no unresolved in-scope defect remains. Copy Link, rotated PDF, fixed-layout and mixed-direction EPUB screenshots were visually inspected; no rendering exception was observed in this created corpus. A13 was not rerun: search scanning, process allocation and book/cover loading are unchanged; the new navigation work is limited to clicked links. Book-length catalog search/sizing was rerun here; full milestone acceptance and later release measurement remain separate gates. The first new native attempt evaluated Electron before startup completed and hit an embedded-Node fetch initialization error; waiting for the normal library-ready marker removed that test setup race. No runtime workaround or dependency change was made.

Limits: created corpus on this Arch/Hyprland display at scale 1, including controlled 600×420 content viewports; no claim of arbitrary publisher-book compatibility or other graphics/font environments. Remote/scripted features remain unsupported. Save/load recovery and crash containment remain M5-03/M5-04; integrated milestone-five acceptance remains M5-05. No commit was created.
