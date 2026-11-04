# Borges

A planned personal, fully offline PDF/EPUB library manager and reader for Arch Linux. Organize books in overlapping nested sections, find them by author/subject, track reading status, and read in separate single-page windows.

Status: development build, not yet a usable personal release. Verified: the multi-window Electron shell (reopening a reader requests activation, which this Hyprland policy answers with an urgency hint, a recorded platform limit); offline PDF/EPUB rendering, interaction and isolation; the versioned, locked SQLite catalog with migrations and startup reconciliation; catalog readers with centrally coordinated autosave; A13 measurements with a 500-entry catalog; and the library window (browsing, search/filters, sections, status/Archive and metadata editing). Import, replacement, Trash, covers and the reader's final controls are pending. Borges is the project name. The accepted stack is TypeScript, React/CSS, Electron, SQLite, PDF.js, and pinned foliate-js.

## Development

```sh
mise run dev
mise run check
mise run smoke
mise run smoke-packaged
mise run measure
```

See [development setup](docs/development.md) for installation, exact versions, system dependencies, verification results, and individual commands. For a fresh checkout, run `mise trust`, `mise install node pnpm`, then `mise run setup`.

## Project documents

- [Specification](docs/spec.md): scope, behaviors, delegated defaults, acceptance criteria, and deferred features.
- [Architecture](docs/architecture.md): module contracts, data model, reader isolation, and file/database recovery.
- [Implementation handoff](docs/implementation-plan.md): ordered milestones, spike gates, verification, and remaining technical checks.
- [Agent instructions](AGENTS.md): how an implementation agent should work in this repository.
- [Stack decision](docs/adr/0001-desktop-stack.md) and [source-backed research](docs/stack-research.md): rationale and trade-offs.

Implementation continues in milestone three (covers, startup problems in a window, and visual prototypes for the user's feedback). The implementation plan's "Where to resume" entry lists the next tasks and working notes. Appearance is provisional until those prototypes.
