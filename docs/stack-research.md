# Desktop and reader research

Investigated: 2026-11-03. Status: recommendation accepted by the user; [ADR 0001](adr/0001-desktop-stack.md) records the decision and validation gate. Documentation describes capabilities, not verified behavior on the user's machine. This is a bounded candidate comparison, not an exhaustive survey.

Requirements are maintained in [spec.md](spec.md). The immediate question is whether multiple offline reader windows create enough complexity to exclude them, and which existing rendering components merit evaluation.

## Desktop candidates

| Candidate | Documented facts | Design assessment / remaining verification |
| --- | --- | --- |
| Electron with a TypeScript UI | A main process manages application windows; each BrowserWindow has a separate renderer process. Electron bundles Chromium and Node.js. [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) | Multiple reader windows fit the documented model. TypeScript could cover both application logic and UI, reducing language boundaries. Bundled runtime footprint and per-window resources are trade-offs to measure. |
| Tauri with a TypeScript UI and Rust application layer | WebviewWindow supports ordinary multiple-window applications. Linux rendering uses WebKitGTK. [Window API](https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/), [webview versions](https://v2.tauri.app/reference/webview-versions/) | Multiple reader windows also fit this model. System webview behavior must be checked on the target Arch setup; introducing Rust plus a web UI adds a language boundary. No comparative performance claim is established. |
| Python with PySide6/Qt | QPdfView documents single-page mode, zoom/fit controls, and a search model. [QPdfView](https://doc.qt.io/qtforpython-6/PySide6/QtPdfWidgets/QPdfView.html) | A viable native PDF path. EPUB integration, modern UI approach, licensing, and distribution would require additional investigation before preferring it over the web-rendering candidates. |

## Reader candidates

- **PDF.js:** Mozilla's PDF parsing/rendering platform, Apache-2.0 licensed. Candidate for the PDF adapter in a web-rendered UI. Offline assets, text search, text selection, image fidelity, and rendering limits need an integration check. [Project](https://mozilla.github.io/pdf.js/)
- **foliate-js:** MIT-licensed browser ebook library with paginated/fixed-layout renderers, EPUB location/CFI support, and search. Its PDF support is experimental; prefer a separate PDF.js adapter. Its API is explicitly unstable and has no release; pin a reviewed commit and isolate it behind an adapter. Search is documented as slow; use incremental results. Validate single-column pagination, typography changes with durable resume, fixed-layout single-page behavior, and search responsiveness. Extra formats do not automatically enter scope. The project requires content security controls to block scripted EPUB content. [README](https://github.com/johnfactotum/foliate-js)

## Recommendation and unknowns

The user accepted multiple different books in separate windows and at most one reader per book; see the spec for the complete window policy. Framework window primitives already exist. One application-owned persistence service is now an agent-selected architecture default under the user's delegation, to coordinate progress and metadata writes. See [architecture](architecture.md).

## Accepted stack and rationale

Agent recommendation accepted by the user:

| Component | Choice | Reason / trade-off |
| --- | --- | --- |
| Application language | TypeScript | One application language across desktop coordination and UI; reader libraries are JavaScript. This is a maintainability assessment, not a measured performance advantage. |
| UI | React with CSS | Component-based interface suitable for library and reader controls; visual quality still depends on later design/prototyping. [React documentation](https://react.dev/learn) |
| Desktop shell | Electron | Documented multi-window architecture and bundled Chromium suit browser reader engines. Higher runtime/distribution footprint is a trade-off; measure real idle and two-reader usage rather than promise low memory. Tauri remains an alternative if that cost is unacceptable. |
| Catalog | SQLite | Intended for local application storage; no database service required. Keep book binaries as managed files, with catalog relationships, progress, and recovery metadata in SQLite. [SQLite use cases](https://www.sqlite.org/whentouse.html) |
| PDF | PDF.js | Existing parsing and page rendering; supports building a page-at-a-time viewer. [Examples](https://mozilla.github.io/pdf.js/examples/) |
| EPUB | Pinned foliate-js behind an adapter | Candidate for pagination, embedded content, and persistent EPUB locations; API instability and integration quality require validation. |

SQLite binding remains a bounded implementation investigation: check `node:sqlite` availability/API in the selected Electron's embedded Node runtime before adding a driver. Current standalone Node documentation does not prove that runtime's support. If a native driver is needed, better-sqlite3 documents Electron rebuild and packaging requirements. Validate compatibility before pinning. [Node SQLite API](https://nodejs.org/api/sqlite.html), [better-sqlite3 Electron notes](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)

This choice prioritizes a cohesive implementation over the smallest runtime. Python/Qt remains viable but would require additional EPUB integration investigation; Tauri trades a system webview and Rust/application boundary against Electron's bundled runtime. No benchmark establishes a universal winner.

Before full implementation, a small integration spike should verify one PDF, a reflowable EPUB, an image-heavy/fixed-layout example, text search, typography changes with durable resume, SQLite persistence, and two concurrent readers on Arch. The spec defines reader location semantics. Failure of a gate reopens the relevant component choice; acceptance of the stack is not proof that every integration works. Subsequent development setup installed pinned dependencies and verified a diagnostic shell/SQLite baseline; the reader and two-window integration checks remain pending. See [development setup](development.md).

Offline reading should package all required assets locally. Book content needs an appropriate isolation boundary; for Electron, the official guidance calls for renderer isolation and sandboxing, limited navigation, and narrow validated application messaging. These are implementation considerations, not additional user-facing features. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
