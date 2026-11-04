# Implementation architecture

Status: agent-selected design under the user's delegation of routine behavior/storage decisions. The [spec](spec.md) is authoritative; [ADR 0001](adr/0001-desktop-stack.md) records the stack. These are contracts for future code, not claims of completed implementation.

## Responsibilities

One Electron application service coordinates writes. React views request operations and display results; they must not manage raw filesystem/SQLite operations.

| Module | Public contract | Complexity owned inside |
| --- | --- | --- |
| Library service | Query; edit metadata/sections; change status/archive | Identity, validation, view/search rules, metadata precedence |
| Import/recovery service | Plan import; resolve duplicates; replace; trash/restore/purge | Staged bytes, file validation, revision changes, crash reconciliation |
| Window/session coordinator | Open/focus book; open library; quit | One window per book, lifecycle, progress flushing, session ownership |
| Reader session | Open; navigate; search/cancel; size; capture/restore location; dispose | Format-specific rendering, stable locations, isolation, resource cleanup |
| Catalog/storage internals | Private to services | Transactions/migrations, relative paths, immutable file publication, recovery records |

PDF and EPUB are actual variants, so use format adapters behind a common session contract. Locations remain a discriminated union, not one generic page integer. Expose real capability differences: font resizing versus page zoom, missing outline, unavailable text. Engine objects stay inside adapters. No plugin framework or hypothetical database abstraction is needed.

Suggested organization when coding starts:

```text
src/main/       lifecycle, window coordinator, validated messaging
src/library/    catalog rules, metadata/sections/status, import/recovery
src/storage/    schema/migrations and managed-file internals
src/preload/    narrow typed application bridge
src/ui/         library and reader controls
src/readers/    session contract, PDF.js and foliate-js adapters
tests/          behavior/storage/Electron checks and tiny licensed fixtures
```

These are organizational defaults, not one class/file per responsibility.

## Process and content boundaries

- Main application services own catalog writes and validate commands. Expensive copying/hashing/extraction/search must not block the interactive main event loop. Use bounded jobs/workers where needed rather than a process per trivial operation.
- UI receives IDs, approved revision tokens, and structured data, not an arbitrary filesystem/SQL/Electron bridge. Validate the sender and window assignment for every privileged message.
- Progress includes book ID, revision ID, session generation, and monotonic sequence. Reject late/reordered writes and messages from a window not assigned to that book. Session generation changes on replacement/reread/disposal.
- Implemented progress contract (M2-02, `src/library/progress.ts`): the generation is durable. `beginReaderSession` advances `books.session_generation` and returns the current revision's last committed position/sizing, so opening or reloading a reader retires any earlier session. `saveProgress` parses the untrusted message and then, in one `BEGIN IMMEDIATE` transaction, requires a live book, the current revision, the live generation, a matching format and a sequence above the stored one for that generation. It writes the position and per-book sizing together and acknowledges only after commit. `endReaderSession` retires a generation after its final flush. Replacement, deletion and reread must switch state and advance the generation in the same commit. Failures are typed (`invalid`, `unknown-book`, `stale-revision`, `stale-session`, `out-of-order`, `storage-failed`) and leave the last committed state unchanged. A committed save takes about 42 ms on the home HDD and runs synchronously on the main thread.
- Implemented reader IPC (M2-05, `src/main/sessions.ts`): `ReaderSessions` keys each session by the reader window's webContents ID. A catalog reader window calls `reader:open-book` with no arguments; main uses the book assigned to that window, starts a session (any earlier session of the window, such as before a reload, is flushed and retired first) and returns the grant with the current revision's bytes. The shell keeps the grant. It passes only the bytes and the saved position/sizing to its engine frame (`content.html?catalog`, origin `borges://reader`) and accepts messages only from that frame's window at that origin, never from chapter frames. It numbers the engine's positions and sends them over `reader:progress`. Main drops messages from unregistered or non-main frames, then rejects with `not-assigned` any write naming a book other than the window's, `stale-session` any other generation, and `out-of-order` any sequence at or below the last accepted one, before storage applies its own checks. Accepted positions are coalesced: the latest is committed 250 ms after the first pending one, and the result (`reader:progress-result`) is shown in the shell. A storage failure keeps the write pending for retry; other rejections do not raise the sequence floor. Window close, reload and Quit flush the pending position synchronously and retire the session. `reader:opened` records a successful open (status rules in the library service) only for the window's current generation. The engine never receives the generation; a compromised engine could at most move its own book's position.
- Disable renderer Node integration; enable context isolation and sandboxing. Give only trusted application UI a narrow preload bridge. Isolate book content from that bridge and the application origin's privileges.
- Block book scripts, remote requests, top-level navigation, unsolicited windows, and arbitrary filesystem access. Resource serving permits approved revision/cover assets only, validates canonical paths, and rejects traversal/symlink escapes. Verify the design against foliate-js's CSP requirements during the spike; do not enable unsafe flags to render a sample.
- Bundle required PDF workers/fonts/CMaps and EPUB assets for offline use. Support permitted local images/fonts while blocking scripted/remote content.
- Use a single-instance coordinator and an exclusive configured-library lock before writing. A second ordinary launch routes to the first, which reopens or reuses its library window and requests activation. Another build/process holding a root lock must yield an explanation, not competing writers. Verify lock ownership before stale-lock recovery.
- Implemented root lock (M2-01): one SQLite connection holds an `EXCLUSIVE` lock (`locking_mode = EXCLUSIVE`, a POSIX advisory lock) on `library.lock` for the process lifetime. The kernel releases it when the holder exits or is killed, so successfully acquiring it is the ownership check; no PID heuristics or lock-file deletion are involved. `library.lock-owner.json` only names the holder in conflict explanations and is replaced after acquisition, which is reported as stale-lock recovery. The holding process must never open/close `library.lock` through `node:fs`, because closing any descriptor drops that process's POSIX locks. The root must be on a local filesystem with working POSIX locks.

Primary references: [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [security](https://www.electronjs.org/docs/latest/tutorial/security), [lifecycle/single-instance APIs](https://www.electronjs.org/docs/latest/api/app), [foliate-js](https://github.com/johnfactotum/foliate-js).

Diagnostic fixture readers still use bundled allowlisted fixtures and hold no progress session; catalog readers receive their bytes over IPC as described above. Canonical bundle paths, assigned frame navigation and malicious-content checks are verified in [M1-05 evidence](development.md#adversarial-readerresource-isolation-m1-05). Sender/revision/generation/sequence validation for catalog readers is verified natively by M2-05; cover grants remain for the library UI.

## Library service (M2-04)

`src/library/query.ts`, `sections.ts` and `books.ts` implement the library service against the catalog; inputs are validated as untrusted and failures are typed `LibraryError`s (`invalid`, `unknown-book`, `unknown-section`, `name-conflict`, `section-cycle`, `storage-failed`). Writes run in one `BEGIN IMMEDIATE` transaction.

- **Scope in one place:** `scopedBooks` applies deleted (never shown), archived (hidden unless `includeArchived`; Archive shows only archived) and view (All Books, Unfiled, section branch, Currently Reading, Finished, Archive) scope in one SQL query. Search terms, author/subject filters and sorting run in JavaScript over that result, with `Intl.Collator` ordering (base sensitivity, numeric).
- **Normalization:** `foldKey` (NFKC, case folding via upper-then-lower, trimmed, repeated whitespace collapsed) is the single comparison key. Stored `sections.name_key` and `book_subjects.label_key` hold it, so changing it requires a migration that rewrites them. Search terms are substrings of folded fields, so SQL wildcards are literal.
- **Sections:** sibling names are unique by key (root siblings included); moves into the branch itself are rejected before the schema trigger. Deletion reports the branch's section, affected-book and newly unfiled counts for confirmation and relies on the schema's cascade.
- **Status:** `recordSuccessfulOpen` is called only after a reader rendered the book. `startRereading` sets Currently Reading, clears Archive, deletes the current revision's position and advances the session generation in one commit; the coordinator must flush and stop the open session first and restart it with a new grant.
- **Metadata:** `editMetadata` replaces title, ordered authors or the subject set and marks only the edited fields manual. Covers and extraction precedence arrive with import/metadata work.
- **IPC:** only `queryBooks` is exposed so far, as `library:books`, to the library window only. The renderer's query is passed through `parseBookQuery` unchanged; no argument means All Books. Section, status and metadata writes have no IPC yet (milestone three).

## Data model

Use foreign keys and versioned migrations. Exact SQL/indexes are implementation details; preserve these meanings. Schema 1 implements them in `src/storage/schema.ts`; later changes append forward-only migrations:

| Record | Meaning |
| --- | --- |
| Book | Stable ID, current revision, reading status, archive/delete timestamps, created/updated/last-opened times |
| Revision | ID/owning book, format, relative path, hash/size, original display filename, created/retired times, extracted metadata |
| Metadata | Effective title, ordered authors, flat subjects, cover, field-level manual-override provenance |
| Section/membership | Parent/name and many-to-many book membership; no cycles or duplicate memberships |
| Position | Revision-specific PDF page/normalized pan or EPUB locator/chapter/fraction, sequence/update time |
| Reader settings | Book and format-compatible font/fit/zoom settings |
| Recovery operation | ID/type/state, involved IDs, staged/published paths, enough outcome data for reconciliation |
| Trash state | Deleted book or retired revision with enough file/location/catalog context to restore |
| Library metadata | Library identity/schema version, independent of absolute root path |

Invariants:

1. A live book has one current revision, referencing published bytes rather than a partial staged file.
2. Revisions are immutable. Membership never copies/moves bytes. Source paths are provenance, not mutation targets.
3. Position belongs to a revision. A retired session cannot overwrite replacement progress. Status/archive/manual metadata belong to the book.
4. Trash/recovery records retain their bytes until explicit purge. Purge must not delete a live revision or still-referenced cover/resource.
5. Durable paths are relative. Titles/filenames are display metadata, not identity.
6. Manual override provenance includes explicit empty optional values, so extraction cannot resurrect cleared metadata.

Normal queries restrict deletion/archive/view scope in one place. Duplicate candidates use current live revisions, including archived entries; Trash-only matches use restore handling. Hashes identify equality candidates; metadata only suggests identity. UI and SQL validation must agree on normalization/uniqueness.

## Filesystem/database consistency

SQLite transactions do not include filesystem changes. Implement immutable publication plus a recoverable operation protocol:

1. Allocate operation/revision IDs and record pending work. Stream into private staging on the library filesystem while hashing; validate candidate content with bounded resources. Failure/cancellation leaves the old book unchanged.
2. Resolve duplicate choices against current catalog state. Recheck the target before commit; an old preview is not permission to overwrite a changed entry.
3. Before replacement/deletion/reread of an open book, save its old position, stop the old session, and advance session generation.
4. Publish complete bytes to an immutable final path using same-filesystem rename and appropriate durability handling. Retain enough operation state to reconcile a crash around publication.
5. Commit new-book/current-revision/metadata changes and old-revision retirement together in SQLite. Mark the operation complete only after catalog references point to published bytes. Retain old file/location in Trash.
6. Refresh views/reload the reader after commit. Precommit failure retains/reopens the old revision. A notification/reader failure after commit does not undo or misreport the committed catalog change; report it as a reader error and preserve the previous revision in Trash. Clean up only artifacts whose status/references are known.

Implemented for import (M2-03, `src/library/import.ts` and `recovery.ts`): states `pending` (partial copy may exist at `staged_path`), `staged` (digest recorded; bytes at `staged_path`, or at `published_path` after an interrupted rename), `published`, then `committed` in the same transaction as the book/revision rows. Each state is committed only after the step it records is durable (file fsync; directory fsync after rename/unlink). An import that did not commit is rolled back, both after an in-process failure and at startup: only record-named regular files are removed, and a complete copy only when it matches the recorded digest, then the operation is `abandoned`. The untouched source can be imported again. Uncertain leftovers are retained and the operation is marked `failed`, which startup reports each time and never touches. A removal that fails leaves the state unchanged so the next start retries. Unrecognized `staging/` and `files/` entries are reported and kept. Replacement will need roll-forward/rollback rules of its own; this build marks non-import operations `failed`.

Crash before catalog commit leaves old state current plus recoverable staged/published data. Crash after commit leaves the new revision current and old revision recoverable. Startup inspects records, actual paths, and references; filenames alone do not prove cleanup safety. Preserve uncertain data and report repair diagnostics. Record tested durability limits; do not promise power-loss immunity without evidence.

Purge only catalog-confirmed eligible resources. Failed deletion retains a retryable Trash record; an interrupted purge is reconciled without confusing missing Trash bytes with live-file loss. Never implement purge as recursive deletion of the library root or a source path. Restore/delete operations must satisfy the spec even when sections or newer revisions have changed.

## Storage and resources

Agent-selected durable layout:

```text
library/
  catalog.sqlite          catalog, identity/schema, positions, Trash, recovery state
  library.lock            root lock held while Borges runs (see process boundaries)
  library.lock-owner.json holder description while running; diagnostic only
  files/<revision-id>.*   immutable live and recoverable PDF/EPUB revisions
  covers/                 referenced durable covers, including manual corrections
  staging/                operation-scoped incomplete copies
  recovery/               catalog migration snapshots/diagnostics when needed
```

Catalog upgrades (M2-01) run every pending migration in one transaction with foreign keys checked before commit. Before upgrading an existing catalog, a `VACUUM INTO` snapshot is verified (`quick_check`, old version) and renamed into `recovery/catalog-schema-<from>-before-<to>-<time>.sqlite`; snapshots are retained. A catalog is identified by `PRAGMA application_id` and versioned by `user_version`. Newer, foreign, unreadable or damaged catalogs are refused before any write. Damage means the stored schema differs from what the migrations produce from scratch, so manual extra indexes are also refused. Schema 2 (M2-02) adds `books.session_generation` and `positions.generation`.

Trash is catalog state; it need not physically move every file. SQLite sidecars belong with the catalog. Back up the whole root while all application windows are closed, and prove a copied root works without the original path. Default root follows the [XDG base-directory convention](https://specifications.freedesktop.org/basedir/latest/). External runtime caches/logs are disposable.

Render current pages and bounded adjacent resources for open books only. Dispose workers/documents/object URLs/image buffers/listeners on close. Generate thumbnails lazily with bounded concurrency/cache; browsing 500 entries must not instantiate 500 readers. Make long searches cancellable and incremental. Diagnostic packaged budgets are recorded in [M1-07 evidence](development.md#packaged-runtimeresource-measurements-m1-07); catalog/500-entry budgets follow the milestone-two catalog. M1-07 also observed that all readers' `borges://reader` content frames share one renderer process. Book content still has no host bridge, but one book's renderer crash or memory growth reaches other readers. Milestone five should decide from crash-containment evidence whether each reader needs a distinct content origin.

## Remaining technical checks

The implementation agent owns milestone one in [implementation-plan.md](implementation-plan.md): compatible pinned versions/SQLite binding, EPUB stable locations/single-page fixed layouts/content isolation, document search, two windows, and real Arch display/resource behavior. These are engineering checks with explicit next steps, not unanswered product preferences.
