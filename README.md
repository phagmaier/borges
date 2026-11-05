# Borges

A personal, fully offline PDF/EPUB library and single-page reader for Arch Linux. Import copies your originals, organize books in overlapping nested sections, search metadata, track status/Archive, and read in independent windows with saved positions. Replacement and Trash retain old bytes and locations until you purge.

The agreed personal baseline is complete: all six milestones and the fresh-seeded 500-book release measurements pass. See the handoff and development evidence for exact checks and limits. The target is Arch/Hyprland/Wayland at scale 1. Reopening requests activation; this compositor policy may answer with urgency, requiring one click to focus. The accepted stack is TypeScript, React/CSS, Electron, SQLite, PDF.js, and pinned foliate-js.

## Build and use

```sh
mise trust
mise install node pnpm
mise run setup
mise run package
./dist/borges/launch
```

The complete `dist/borges` directory contains Electron/readers, a launch script, desktop entry/installer, user guide, build information and notices. Move the whole directory together. Runtime use needs no Node, pnpm, checkout or network service. Setup needs network access for uncached dependencies.

```sh
./dist/borges/launch --install-desktop
./dist/borges/launch --library-root '/absolute/path/to/My Library'
```

See the [user guide](docs/user-guide.md) for desktop registration, controls, library-root configuration, closed-folder backup/restore, Trash and runtime prerequisites. Default library: `~/.local/share/borges/library`, respecting XDG_DATA_HOME. The personal profile is separate from development.

## Development

```sh
mise run dev
mise run check
mise run smoke
mise run smoke-packaged
mise run smoke-delivery
mise run measure-delivery
```

See [development setup](docs/development.md) for installation, exact versions, system dependencies, verification results, and individual commands. For a fresh checkout, run `mise trust`, `mise install node pnpm`, then `mise run setup`.

## Project documents

- [Specification](docs/spec.md): scope, behaviors, delegated defaults, acceptance criteria, and deferred features.
- [Architecture](docs/architecture.md): module contracts, data model, reader isolation, and file/database recovery.
- [Implementation handoff](docs/implementation-plan.md): ordered milestones, spike gates, verification, and remaining technical checks.
- [Agent instructions](AGENTS.md): how an implementation agent should work in this repository.
- [Stack decision](docs/adr/0001-desktop-stack.md) and [source-backed research](docs/stack-research.md): rationale and trade-offs.

Development and the diagnostic artifact retain created fixture readers; the personal bundle omits diagnostic fixtures. Run native GUI suites serially. Public/AUR/AppImage distribution, Calibre migration and cloud features remain outside this personal version. No original source books are bundled.
