# Borges

A personal, fully offline PDF/EPUB library and single-page reader for Arch Linux. Import copies your originals, organize books in overlapping nested sections, search metadata, track status/Archive, and read in independent windows with saved positions. Replacement and Trash retain old bytes and locations until you purge.

All six personal-baseline milestones are complete. The handoff and development evidence record the checks, 500-book measurements and remaining limits. The target is Arch/Hyprland/Wayland at scale 1. Reopening requests activation; this compositor policy may answer with urgency, requiring one click to focus. The accepted stack is TypeScript, React/CSS, Electron, SQLite, PDF.js, and pinned foliate-js.

## Download and install

For x86-64 Arch Linux, download `borges-0.1.0-linux-x86_64.tar.gz` and
`SHA256SUMS` from the [v0.1.0 release](https://github.com/phagmaier/borges/releases/tag/v0.1.0).
Run these commands in the folder containing both downloads:

```sh
sha256sum -c SHA256SUMS
mkdir -p ~/.local/opt
tar -xzf borges-0.1.0-linux-x86_64.tar.gz -C ~/.local/opt
~/.local/opt/borges/launch --install-desktop
~/.local/opt/borges/launch
```

You can then open Borges from your application menu. The archive includes the
runtime; no Node, pnpm or source checkout is needed on the laptop. Native Arch
runtime libraries and a working Chromium sandbox are required; see the
[user guide](docs/user-guide.md#requirements-and-limits). This is a personal-target
prerelease, verified on the development Arch/Hyprland desktop; the laptop still
needs its first local check. Updates are manual: quit all Borges windows before
replacing the application folder. Your library is stored separately.

## Build from source

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

Development and the diagnostic artifact retain created fixture readers; the personal bundle omits diagnostic fixtures. Run native GUI suites serially. The GitHub archive targets the same personal Arch setup; AUR/AppImage packaging, other platforms, Calibre metadata migration and cloud features remain outside this version. No original source books are bundled.
