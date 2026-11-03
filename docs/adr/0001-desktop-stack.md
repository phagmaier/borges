# Use TypeScript, Electron, and existing reader engines

Accepted by the user during requirements discovery on 2026-11-03.

Use TypeScript for application code, React/CSS for the interface, Electron for offline desktop windows, SQLite for catalog data, PDF.js for PDF, and a pinned foliate-js revision behind an EPUB adapter. This gives the personal Arch Linux application a common language across its desktop coordination and interface and supports the accepted separate-reader-window workflow. Keep original book bytes as managed files rather than encoding them in UI state.

Electron's bundled runtime footprint is an accepted trade-off for a cohesive implementation. Tauri remains a possible alternative if measured runtime cost proves unacceptable, but it would introduce a Rust/application boundary and Linux system-webview behavior to validate. Python/Qt offers native PDF facilities but would need further EPUB integration investigation. These are project-specific design judgments; no benchmark establishes a universal framework ranking. Evidence and source links are in [stack research](../stack-research.md).

foliate-js explicitly has an unstable API. Pin a reviewed commit and isolate it behind a narrow reader adapter. Before building the full application, verify offline PDF/EPUB rendering, images, single-page navigation, search, durable EPUB resume after font/window changes, SQLite persistence, and two concurrent readers on the user's Arch setup. Confirm the SQLite API/driver against Electron's embedded Node runtime and pin compatible versions. A failing gate requires evidence and a focused revision of the affected component, not silent substitution. This validation is future implementation work, not completed research evidence.
