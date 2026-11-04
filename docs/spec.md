# Borges — version-one specification

Status: discovery complete; development scaffold/toolchain are installed. The minimal shell and embedded SQLite work; fixture rendering, reader interactions, explicit snapshot restoration and diagnostic adversarial isolation are verified. Packaged-runtime SQLite persistence/schema handling is also verified, and the versioned catalog with migrations and the exclusive library-root lock is implemented (M2-01). Catalog-backed progress/session validation, library features and packaged resource measurements remain pending. See [development setup](development.md) for the verified subset. Updated 2026-11-03. Borges is the project name.

The user confirmed the product choices below and delegated remaining routine behavior/storage defaults to the agent. **Agent-selected defaults** identify that delegation. The information layout is provisional; exact appearance is deliberately deferred to later prototypes.

## Purpose and scope

A standalone, fully offline library manager and integrated reader for one person's Arch Linux machine, replacing Calibre plus external readers. Prioritize useful organization, a pleasant interface, and dependable progress. Other users and portability must not drive version one.

Include PDF/EPUB with images, local file/folder import, metadata editing, nested sections with overlapping membership, author/subject search, reading status/Archive, separate single-page readers, progress, sizing, text search, replacement, and recoverable Trash. Design for hundreds of books without an arbitrary numerical cap. Active library status does not mean loaded into memory.

Support DRM-free EPUBs and unencrypted PDFs initially. Explain unsupported protected files clearly; no decryption/account integration. Ordinary EPUB font obfuscation is not itself account-based DRM; evaluate it in the reader spike.

## Accepted technology

| Concern | Choice |
| --- | --- |
| Application language | TypeScript |
| Interface | React and CSS |
| Desktop shell | Electron |
| Catalog | SQLite |
| PDF | PDF.js |
| EPUB | Pinned foliate-js revision behind an adapter |

See [ADR 0001](adr/0001-desktop-stack.md), [research](stack-research.md), [architecture](architecture.md), and [implementation plan](implementation-plan.md). Compatible versions, SQLite binding, and actual reader behavior require a bounded spike before full implementation. Stack acceptance is not evidence of a working integration.

## Terminology and state

- **Book:** one entry with one current file revision. Different files/formats are separate entries unless explicitly replacing an existing entry's file.
- **Revision:** immutable managed PDF/EPUB bytes and file-specific position. Replacement changes the current revision, not the book ID.
- **Section:** logical nested grouping; a book can have several memberships without extra file copies. Sections do not rearrange source directories.
- **Reading status:** Unread, Currently Reading, or Finished.
- **Archived:** independent flag; retained and organized, but hidden from normal browsing/search.
- **Active:** not archived/deleted; not a resource-management term.
- **Trash:** recoverable deleted books and superseded revisions, distinct from Archive. No automatic purge.

| Action | Reading status | Archive/position effect |
| --- | --- | --- |
| Import | Unread | Not archived; initial position. Agent-selected initial state. |
| Successfully open unread, nonarchived book | Currently Reading | Start/resume. |
| Open in-progress book | Preserve | Resume. |
| Mark Finished | Finished | Keep position/archive flag; reaching last page does not finish automatically. |
| Open finished book for reference | Finished | Resume without starting a reread. |
| Archive any book, including unread | Preserve | Set archived; keep position/sections. |
| Open archived book for reference | Preserve | Keep archived; resume. Explicit exception to unread first-open rule. |
| Unarchive | Preserve | Clear archived; retain position. |
| Start Rereading | Currently Reading | Unarchive and reset to beginning. |
| Replace file | Preserve | Preserve archive flag/sections; reset new revision's position. |

**Agent-selected defaults:** failed loading does not change status. Archive/unarchive/Finish do not close a reader. Reread quiesces any open session and restarts its reader at the beginning. No reading-session history or time analytics is promised.

## Organization and presentation

Accepted working layout: sidebar with nested sections, Currently Reading, Finished, and Archive; main cover/title grid with optional compact list. Exact colors, typography, density, and styling belong to later prototypes, not an assumed component-library default.

**Agent-selected defaults:**

- Add All Books, Unfiled, and Trash access. All Books excludes archived/deleted by default; Unfiled has no memberships.
- Create/rename/move/delete sections. One parent per section; reject cycles. Names are trimmed, nonempty, and unique among siblings ignoring case, including root siblings.
- Adding membership never removes other memberships. Removing membership never deletes a book.
- Deleting a section removes its entire descendant branch and those memberships after confirmation showing affected section/book counts. Preserve book files and surviving memberships. Newly unfiled entries remain in Unfiled. Section-tree undo is not part of book Trash.
- Parent sections show entries from the section and descendants, once per book. Counts use unique book IDs.
- Default sorting: title, author, stable ID. Currently Reading sorts by last opened; Archive by last archived. Start with system color preference; detailed styling/themes remain for prototyping.

## Metadata and search

Extract available title, authors, subjects, and cover locally; allow corrections. Missing metadata must not block import: filename without final extension supplies missing title, other unknown fields stay empty. No Calibre metadata migration or online metadata lookup.

**Agent-selected defaults:**

- Ordered authors; flat subject-label set, independent of section paths. Preserve display spelling, deduplicate subject labels ignoring case. Manual edits override extracted values, including intentionally cleared optional fields.
- Nonempty display title required. Allow a local cover-image correction and store it inside library data; missing/unusable covers use a placeholder.
- Search title/author/subject; provide author/subject filters. Whitespace-separated terms must each match at least one field, ignoring case. No regex/fuzzy search required; SQL wildcard characters are literal user input.
- Search filters the selected view; All Books searches across sections. Include archived is off by default in ordinary views/search, with an explicit toggle. Archive searches archived entries only. Trash is separate and never in normal results.
- Catalog search is metadata search. Reader `/` searches one book's existing text; cross-library full-text indexing is deferred.

## Import and duplicates

Select files/folders and copy supported books into app-managed storage. Never move, rename, edit, or delete source files. Different files, including PDF/EPUB versions of a title, are separate entries unless the user chooses replacement.

Confirmed rules:

- Skip byte-identical imports already live, including archived entries; show the existing entry.
- Different files with matching title/author metadata prompt **Keep Both, Replace, or Skip**. Never silently replace/merge. Keep Both creates a distinct entry even when metadata matches.
- Provide manual Replace File for metadata mismatches or a better downloaded copy.

**Agent-selected defaults:**

- Recurse through ordinary subdirectories; do not follow directory symlinks, rescan managed storage, or process the same resolved input twice in a batch. Explicitly selected file symlinks can be read/copied without modifying targets. No source-folder watching.
- Validate format against content and extension; reject unsupported/mismatched content with a reason. Stream copying/hashing and bound parallel work.
- Use a cryptographic content hash for equality candidates, verifying equality as needed. For metadata suggestions normalize Unicode, case, trimming, and repeated whitespace; require equal nonempty titles and at least one shared nonempty author. Preserve punctuation; do not guess from missing authors or filename alone. Show all candidates and require a specific replacement target.
- A hash present only in Trash produces a restore/reuse-or-cancel choice, not silent discard. Revision-restore rules below govern its return to the live catalog.
- Imports/Keep Both from a selected section join that section; other views import into Unfiled. Replacement preserves target memberships. Skipping does not silently add memberships.
- Independent files succeed/fail independently. Summarize imported, skipped/duplicate, cancelled, unsupported, and failed outcomes with reasons. Cancellation retains completed entries, stops further work, and cleans/recovers the current staged operation.
- Metadata/cover extraction failure is a warning with fallbacks. Unrecognizable/unparseable book content fails import. Never create a successful entry referencing a partial copy.

## Replacement, deletion, and Trash

Replacement preserves book ID, sections, reading status, archive flag, and manual metadata. Reset new position; retain old file/location for reference. Superseded files and deleted books remain recoverable until Empty Trash. Sources remain untouched, including during purge. Deleting a section never deletes its books.

**Agent-selected defaults:**

- Validate/copy new bytes before switching. Explicit replacement may change PDF to EPUB or vice versa; retain compatible sizing only. Refresh nonmanual metadata from available replacement values, retaining useful old values if absent.
- For an open book, save old position and stop the old session before switching; reload its window at the beginning after success. Reject stale revision/session writes. Failure before catalog commit keeps the old revision current/readable. A reader-reload error after commit is reported as a reader error; the committed replacement remains current and the old revision stays recoverable.
- Deleting an open book saves/stops/closes its reader before soft deletion. Explain failed close/save; do not claim deletion success while an old session can write.
- Deleted-book restore recovers file, metadata, status/archive, position, and memberships in surviving sections. Do not silently recreate separately deleted sections; show an explanation and use Unfiled if necessary.
- Restore an old revision as current after confirmation: preserve current organization/manual metadata, recover that revision's position, and put the displaced revision in Trash. Alternatively restore as a separate Unread entry without inherited memberships. If identical content is already live, focus it and explain the conflict rather than implicitly replace another book.
- Empty Trash confirms count/storage. Purge only eligible data not referenced by live entries. Partial failures remain visible/retryable. No automatic expiration.
- Reconcile interrupted operations on startup. Preserve uncertain files and provide repair diagnostics. Missing/unreadable managed files keep their catalog entries and offer Replace File or Trash recovery.

[Architecture](architecture.md) defines the file/database operation boundary. SQLite transactions alone do not make filesystem changes atomic.

## Reader

Integrated single-page reading only: no facing pages, split panes, or continuous document scrolling. Images/diagrams/fixed layouts are baseline. Single-page PDF mode does not rewrite columns already printed inside a page.

| Input/control | Behavior |
| --- | --- |
| Right/Down on reader surface | Next page; stop at end, no wrapping. |
| Left/Up on reader surface | Previous page; stop at beginning. |
| `/` | In-book text search. |
| `:` | Jump field: physical PDF page, e.g. `:120`; EPUB percentage, e.g. `:50%`. |
| Contents panel | Navigate available EPUB chapters/PDF outline entries. |
| PDF/fixed-layout sizing | Initially fit whole page; zoom and mouse/touchpad pan within it. |
| Reflowable EPUB sizing | Adjustable font size; preserve same content passage after repagination. |

Save sizing per book. EPUB resume uses content location, not screen-page number. Font/window changes must not send the user to unrelated content.

**Agent-selected defaults:**

- Reader shortcuts require reading-surface focus. Inputs, lists, dialogs, search results, and buttons retain normal keyboard behavior. Provide visible focus/Tab access and visible navigation/sizing/search/jump/contents controls.
- Search existing text only. No OCR. Results show locations/snippets and temporary match highlighting, not persistent annotations. Enter/Shift+Enter traverse matches while searching; Esc closes and restores reader focus. Distinguish no matches from unavailable text, support cancellation/incremental results, and discard stale queries.
- PDF jumps are integers 1 through page count. EPUB jumps are percentages 0 through 100, allowing decimals. Invalid input explains the error without moving. EPUB percentage is estimated content position, not a printed page.
- Support internal links and ordinary text selection/copy where text exists. Persistent bookmarks/navigation history are deferred.
- Pan only within the current zoomed page; wheel/touchpad motion must not become continuous document scrolling.
- Automatically save position during navigation and flush on close/Quit/replacement/deletion/reread. Target persistence within one second during ordinary reading, acknowledge saves, and expose failures. Unexpected termination restores last committed position, not an uncommitted location.
- PDF position: physical page plus normalized within-page pan when applicable. EPUB: CFI/equivalent stable locator plus chapter/fraction recovery context. If exact restoration fails, use best valid chapter/fraction with an approximate-restoration notice; otherwise explain restart at beginning. Never treat another revision's locator as exact.
- Fixed-layout EPUBs use zoom/pan with EPUB percentage/chapter navigation. Scripted/remote/network-dependent book features are not required.

## Windows and offline behavior

One library window; separate readers for different books; at most one reader per book. Reopening reuses the existing reader window and requests activation; where the compositor denies it, one click brings it forward. Closing library leaves readers open; last window closes the app.

**Agent-selected defaults:**

- Start at All Books, without automatically restoring reader windows. Readers can reopen/focus the library. Explicit Quit saves/closes all windows. No tray/background process.
- One coordinating application instance for the configured library. Second ordinary launch reopens a closed library window, or reuses the open one and requests activation (where the compositor denies it, one click brings it forward), instead of competing writes. One configured library initially, no multi-library UI.
- Bundle runtime reading assets/fonts/workers. No accounts, telemetry, online metadata, remote-resource fetching, automatic updates, sync, or runtime network service.
- Block book-initiated external navigation/network/window creation. Offer Copy Link for external references; external browsing is outside the offline flow.
- Initial delivery: local build directory with bundled runtime, launch script, and desktop launcher for Arch. Public/AUR/AppImage packaging is deferred. Validate actual display session/scaling rather than assuming Wayland/X11 behavior.

## Storage and backup

User-confirmed: one self-contained folder with catalog, books, and Trash. Manual backup while all application windows are closed is sufficient. Built-in backup/restore UI, scheduling, and sync are deferred.

**Agent-selected defaults:**

- Root: `$XDG_DATA_HOME/borges/library`, falling back to `~/.local/share/borges/library`. Allow an explicit local-root launch configuration; no multi-library UI.
- Durable metadata, manual covers, positions/settings, revisions, recovery records, and bytes stay inside root. Stable IDs/relative paths permit copying the closed library to a new path. External runtime caches/logs must be disposable.
- Document: close all windows, copy whole folder including SQLite sidecars if present, open restored copy with a compatible app version. Verify restore against a copied test library.
- Version migrations. Before destructive schema change, take a consistent catalog snapshot inside root; it is not a full book backup. Refuse newer unsupported schemas without modifying them. Failed migration preserves prior data.
- Show Trash disk use. No hidden retention limit or purge job.

## Empty and failure states

Empty library invites import; empty hierarchy allows root-section creation. Search with no matches offers clearing filters without implying lost data. Unknown metadata/cover uses editable fallbacks.

Unsupported/protected/corrupt files get per-file reasons without losing other successes or a replacement target. Disk-full, permissions, database, and save errors must not produce false success; retain the last working committed state. Reader errors offer appropriate retry/replace/library actions without disabling other readers. Startup reconciles interrupted work and reports unresolved damage.

## Acceptance and verification

Release criteria, not passing-test claims. Use small known/appropriately licensed fixtures, independently known content markers, real SQLite/filesystem checks for data safety, and actual reader engines for rendering/location checks.

| ID | Acceptance scenario |
| --- | --- |
| A1 | Offline mixed-folder import renders PDF/EPUB images. Missing metadata falls back; protected/corrupt files fail individually without cancelling successes. |
| A2 | One book in two nested branches has one current file; parent results deduplicate. Removing membership/deleting a branch preserves book and surviving branch. |
| A3 | Known title/author/subject searches/filters obey view/archive/Trash boundaries. |
| A4 | Exercise all status/archive transitions, including archived unread reference opening, Finished reference opening, and reread reset. |
| A5 | Two books open, duplicate opening reuses the existing reader and requests activation (where the compositor denies activation, one click brings it forward), library closes/reopens from reader, last window exits; independent positions survive. |
| A6 | Known three-page PDF navigates with agreed keys and `:3`; invalid jumps do not move. Search finds known text; image-only PDF renders/reports text absence. Zoom/pan remains within one page. |
| A7 | EPUB resize/font change/reopen keeps a known passage visible. Verify chapter/percentage jumps, search/images, and single-page fixed-layout EPUB. |
| A8 | Identical reimport skips; matching metadata with changed bytes prompts all choices; Keep Both creates a distinct entry. Manual replacement works with mismatched metadata. |
| A9 | Replacement preserves sections/status/manual metadata, resets position, and retains old file/location in Trash. Open-reader replacement rejects stale writes. |
| A10 | Delete/restore book/old revision, including missing sections/live-content conflicts. Purge never removes a live revision or source. |
| A11 | Inject copy/parse/database failures and terminate around publication/commit. Reopen retains old valid state or committed replacement with recoverable leftovers, never a false successful partial entry. |
| A12 | Close/copy populated library with edits/progress/manual cover/Archive/Trash; copied root works independently. Verify migration rollback/newer-schema refusal. |
| A13 | Use a representative 500-entry catalog and two open readers on Arch. Bound thumbnail/render jobs; no eager loading of unopened books/cap. Record hardware/session, timings, and memory; calibrate numeric budgets in spike rather than invent guarantees now. |
| A14 | Scripted/malicious fixtures cannot run book scripts, fetch remote data, access host APIs, escape resource paths, or spawn app windows; approved local fonts/images work. Reject stale/forged session messages. |

Run appropriate type/lint/format checks, focused behavior/storage tests, and actual Electron smoke tests when implemented. Review meaningful changes and test quality before milestone completion. Detailed visual QA belongs to later prototypes/application work, not this documentation phase.

## Deferred work and remaining checks

Outside version one: other formats, conversion, notes/highlights, OCR, Calibre metadata migration, Vim modes, split/facing pages, continuous scrolling, persistent bookmarks/history, analytics, protected files, cross-library full-text search, cloud/accounts/sync, online metadata, automatic backup/update, multi-library UI, public packaging, and portability. No later milestone is promised.

No unresolved product choice blocks the spike. Bounded technical checks remain in [implementation-plan.md](implementation-plan.md): compatible versions/SQLite binding, EPUB behavior/isolation, Arch display/performance, and local packaging. Visual design remains provisional until later prototypes. Document evidence before revising a disproven technical assumption; do not silently reduce functionality or reopen unrelated decisions.
