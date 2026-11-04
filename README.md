# Borges

A planned personal, fully offline PDF/EPUB library manager and reader for Arch Linux. Organize books in overlapping nested sections, find them by author/subject, track reading status, and read in separate single-page windows.

Status: development tooling and a multi-window Electron diagnostic shell are implemented. Reopening an existing reader requests activation; this Hyprland policy answers with an urgency hint, a recorded platform limit. PDF/EPUB fixture rendering, reader interactions, explicit snapshot restoration, diagnostic adversarial isolation, and packaged-runtime SQLite/schema handling are verified; the versioned library catalog, migrations and exclusive library-root lock are implemented; catalog-backed session validation, automatic progress saving, and library features remain pending. Borges is the project name. The accepted stack is TypeScript, React/CSS, Electron, SQLite, PDF.js, and pinned foliate-js.

## Development

```sh
mise run dev
mise run check
mise run smoke
mise run smoke-packaged
```

See [development setup](docs/development.md) for installation, exact versions, system dependencies, verification results, and individual commands. For a fresh checkout, run `mise trust`, `mise install node pnpm`, then `mise run setup`.

## Project documents

- [Specification](docs/spec.md): scope, behaviors, delegated defaults, acceptance criteria, and deferred features.
- [Architecture](docs/architecture.md): module contracts, data model, reader isolation, and file/database recovery.
- [Implementation handoff](docs/implementation-plan.md): ordered milestones, spike gates, verification, and remaining technical checks.
- [Agent instructions](AGENTS.md): how an implementation agent should work in this repository.
- [Stack decision](docs/adr/0001-desktop-stack.md) and [source-backed research](docs/stack-research.md): rationale and trade-offs.

The next implementation steps are in milestone two (durable catalog and recovery). The toolchain, shell startup, hot reload, sandboxed preload, and built-in SQLite have been checked; fixture rendering/interactions, explicit restoration, and the diagnostic adversarial boundary are checked. The packaged-runtime SQLite/schema gate and diagnostic packaged budgets are verified, and milestone two has started with the versioned, locked catalog. Next is catalog-backed progress/settings storage with session ownership; autosave and full app behavior remain pending. Visual prototypes will refine appearance later.
