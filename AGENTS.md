# Agent instructions — Borges

## Purpose and current state

Build a personal, fully offline PDF/EPUB library manager and integrated reader for Arch Linux. Requirements discovery is complete. Pinned tooling/dependencies, a multi-window diagnostic Electron shell, and startup/SQLite checks now exist. M1-02 is done under a narrowed requirement: reopening reuses the reader and requests activation, which this Hyprland policy answers with an urgency hint (platform-limited; do not edit the user's Hyprland config or add class-wide activation rules); see the implementation plan and development evidence. M1-03 initial fixture rendering, M1-04 reader interactions/explicit snapshot restoration, M1-05 diagnostic adversarial isolation, M1-06 packaged-runtime SQLite/schema diagnostics, and M1-07 diagnostic packaged measurements/budgets are verified; M2-01 catalog schema/migrations/root lock and M2-02 progress storage with durable session generations are done (next: M2-03 staged file publication/reconciliation; the progress IPC wiring is M2-05); catalog/500-entry measurements, catalog-backed stale-session checks, central autosave, library features, and the rest of milestone one remain pending; do not repeat the settled interview.

Borges is the project name. Another user/OS, public distribution, and Calibre compatibility must not drive the first version.

## Read before working

- [Specification](docs/spec.md): authoritative product behavior, accepted choices, explicitly delegated defaults, acceptance criteria, and deferred scope.
- [Development setup](docs/development.md): runnable commands, pins, installed prerequisites, and the actual verified subset. Read when running or changing tooling.
- [Implementation handoff](docs/implementation-plan.md): ordered milestones and validation gates. Read when implementing or planning the next engineering task.
- [Architecture](docs/architecture.md): read before changing persistence, import/recovery, window coordination, or reader adapters.
- [Stack decision](docs/adr/0001-desktop-stack.md): accepted choices and trade-offs. [Research](docs/stack-research.md) supplies evidence, not proof of working integrations.

Keep product behavior canonical in the spec. Update affected documents together when a decision changes. Agent-selected defaults were delegated by the user; routine implementation details do not need another approval round. Ask only about consequential scope/behavior trade-offs that cannot be inferred. A failed technical gate needs observable evidence and a focused fix/revision, not silent feature removal.

## Essential constraints

- Accepted stack: TypeScript, React/CSS, Electron, SQLite, PDF.js, and pinned foliate-js behind an adapter. Validate compatible versions, SQLite binding, offline readers/content isolation, and actual Arch behavior before full implementation.
- Import copies; preserve original files. Sections are nested logical groups with overlapping membership. Different files are separate entries unless the user explicitly replaces one.
- Never silently replace/merge a book. Replacement preserves organization/status/manual metadata, resets the new position, and retains old bytes/location in Trash. Deletion/purge/recovery must not affect sources or live revisions.
- Reading status and Archive are independent. Opening an archived book for reference preserves both. Finish is explicit; Start Rereading unarchives and resets. See the spec's transition table.
- One library window, separate readers, one window per book. Focus existing readers on reopen. Library closure leaves readers open; last window exits. Coordinate all persistence centrally and reject stale reader-session writes.
- Single-page mode, images, ordinary keyboard page turns, `/` search, `:` PDF-page/EPUB-percentage jumps, stable EPUB resume, and per-book sizing. Do not restore superseded Vim/split-page/continuous-scrolling scope.
- DRM-free EPUBs and unencrypted PDFs only. Search existing text; OCR, conversion, notes/highlights, other formats, Calibre metadata migration, cloud/network services, and public packaging are deferred.
- Sidebar/grid/list are working layout assumptions. Detailed appearance belongs to later prototypes. Follow the accepted behavior while visual choices remain provisional.
- All durable library data is in one root with relative paths; manual backup while fully closed is sufficient. File/database recovery needs real failure tests; a database transaction does not cover filesystem mutation.
- Treat imported content as untrusted: no book scripts, network fetches, arbitrary host bridge, resource-path escape, or book-created privileged windows. This is an implementation boundary, not a new account/permission flow.

## Implementation and evidence

Continue the bounded desktop/reader/SQLite spike in the handoff from the verified development-shell baseline. Keep fixtures small and licensed/created; use independent known content markers and real storage/reader behavior. Do not claim a full spike or product acceptance criterion passed based on the setup smoke test.

- `mise run setup`: initialize pinned submodule, install frozen lockfile, download Electron.
- `mise run dev`: hot-reloading diagnostic shell; `mise exec -- pnpm dev --watch` also watches main/preload.
- `mise run check`: strict TypeScript, Biome lint/format, unit tests, production build.
- `mise run smoke`: build plus actual Electron startup/SQLite smoke on an available display.
- `mise run smoke-packaged`: bundle Electron and test a relocated diagnostic artifact, SQLite restarts and schema refusal.
- `mise run measure`: bundle Electron and record launch/reader/search/memory/disposal measurements against machine-specific budgets. Run native GUI suites serially.
- Use `mise exec -- pnpm …` for individual scripts if the shell hook is inactive. Development Node is 26; Electron embeds Node 24, so application Node types target 24. Built-in `node:sqlite` is verified; no separate driver is needed for the current baseline.

For pinned pnpm 12, `pnpm-workspace.yaml` uses the supported `allowBuilds` successor to the shared instructions' legacy `onlyBuiltDependencies`. Keep the same named-package restriction; only Electron is currently allowed. Preserve the strict 1440-minute release gate without global bypass. Do not run the upstream development install inside the foliate-js submodule.

Review each meaningful change against the spec and shared instructions. Use proportionate type/lint/format, behavior/storage, and actual Electron checks. Report gaps in GUI access, samples, unsupported automation, or runtime behavior explicitly. Documentation checks establish document consistency, not successful application behavior.

Development setup is authorized and has been performed. Git was initialized with a pinned foliate-js submodule; no commit/publication was requested or created. Continue ordinary implementation within the user's active request, respecting the agreed milestones and reporting unverified areas.

<!-- codebase-memory-mcp:start -->
For structural codebase exploration, use the installed `codebase-memory` skill. Check freshness and index coverage; use source fallback for uncovered or stale areas. Keep indexing focused on project code; generated output, node_modules, and vendored reader internals are not the default project exploration scope.
<!-- codebase-memory-mcp:end -->

<!-- shared-coding:start -->
Source: /home/phagmaier/skills/instructions/coding.md. Refresh using the setup script.

# Shared coding instructions

Reusable preferences for coding work across agents and projects. This file is maintained in the setup repository. Codex installs a marked copy in its global instructions; refresh it using the setup script when this source changes. Follow the target project's applicable requirements and existing tooling.

## Testing

Keep tests that protect meaningful behavior and realistic failure modes. Choose coverage according to the change's complexity, consequences, and existing coverage.

- Inspect existing tests first. Extend the smallest appropriate test or add a focused case when it covers a distinct behavior or regression.
- Use expected outcomes from requirements, independently worked examples, known fixtures, or a trustworthy independent oracle. A test that repeats the implementation's calculation or compares a value with itself provides no independent check.
- Exercise real behavior through an appropriate interface. A test should detect a plausible incorrect implementation and survive an internal refactor that preserves the contract.
- Use mocks or fakes where isolation is useful, especially at external or nondeterministic boundaries. Verify the real contract; a mock agreeing with its own setup does not establish correctness.
- Cover important success paths, failure paths, edge cases, and regressions. Add overlapping coverage at another level when it catches a distinct failure mode.
- For a reproduced bug, verify that the regression check detects the original problem and passes after the fix. State limitations when the original failure cannot be reproduced.
- Apply testing effort proportionately. Documentation, cosmetic edits, or trivial wiring can often be verified with an existing check or focused inspection. Add a new automated test when it protects a meaningful contract or likely regression, including when apparently simple code has significant consequences.
- Keep fixtures and test helpers as small as the behavior requires. Prefer clear examples and parameterized cases over repetitive tests; add test infrastructure when repeated needs justify it.
- Evaluate test additions during review. Improve or consolidate redundant tests in the touched area when useful; broad test-suite cleanup is a separate task.
- Report the relevant checks, outcomes, and remaining gaps. Run the checks required by the project and the change. Repeat or broaden verification when new changes, failures, or unresolved concerns justify it.

Test-first development is a useful implementation method for suitable behavior changes. A task's verification should still be chosen for its actual requirements and risk. Routine test design is the agent's responsibility; ask the user about consequential behavior choices or trade-offs that cannot be inferred.

## Review before completion

Review meaningful changes against the agreed requirements and project standards before marking the task complete. Include the quality and necessity of added tests. Fix concrete problems within the authorized task, recheck affected behavior, and update task status from the resulting evidence. Report larger design concerns or unrelated cleanup opportunities without expanding the work into an unrequested refactor.

## Package and runtime management

- Use the current standard tool for each ecosystem: `uv` for Python (`uv init`, `uv add`, `uv run`, `uv sync`), `pnpm` for JavaScript and TypeScript, and `mise` for language runtimes and CLI tools. Don't introduce `pip`, `poetry`, `npm`, or `yarn` into a project that already uses the tools above.
- Run project commands through the tool (`uv run`, `pnpm exec`, `mise run`) rather than activating environments or installing packages globally. Don't install packages with `sudo` or into system Python.
- Commit lockfiles (`uv.lock`, `pnpm-lock.yaml`). In CI and deployment, enforce the lockfile: `uv sync --locked`, `pnpm install --frozen-lockfile`.
- Upgrade dependencies deliberately, for example `uv lock --upgrade-package <name>` or `pnpm update <name>`, never as a side effect of an unrelated change.
- Pin runtime and tool versions per project in `mise.toml`.
- Supply-chain hygiene for pnpm: keep pnpm current (10.26.0 or later fixes a git-dependency lifecycle-script bypass), leave install scripts off unless a package needs them (allow them by name via `onlyBuiltDependencies`), and enable the minimum release age gate (`minimumReleaseAge`, 1440 minutes) so brand-new releases wait a day. Bypass the gate only for a named package through `minimumReleaseAgeExclude`, never with a global flag.
- Add a dependency only when the standard library or an existing dependency doesn't cover the need.

<!-- shared-coding:end -->
