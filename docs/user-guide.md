# Borges

Borges is a personal offline PDF/EPUB library and single-page reader for Arch Linux.
It copies imported files; your originals stay where they are. There are no accounts,
online metadata, telemetry, runtime downloads or automatic updates.

## Build and start

In the source checkout, run `mise trust`, `mise install node pnpm`, then
`mise run setup` to install the pinned dependencies. Build with `mise run package`.
Setup may need network access; using the completed application does not.

The resulting `dist/borges` directory contains the application, runtime, reading
assets, this guide, build information and third-party notices. Keep the whole folder
together. You can move it to a permanent location and run its executable `launch`
script from any working directory; installed Node, pnpm and the checkout are not
needed. Close every Borges window before replacing or rebuilding this directory.
The included `borges.desktop` points to the build location; after moving the folder,
register it as described below to generate a launcher for its new path.

```sh
./dist/borges/launch
```

The default library is `$XDG_DATA_HOME/borges/library`, or
`~/.local/share/borges/library` when XDG_DATA_HOME is unset. To use a different
absolute local folder:

```sh
./dist/borges/launch --library-root '/absolute/path/to/My Library'
```

`BORGES_LIBRARY_ROOT=/absolute/path` also configures the library. One library is
configured at a time. Quit all Borges windows before changing it; a second launch
with the same profile reuses the running application. The disposable personal
runtime profile is `~/.config/borges` (under XDG_CONFIG_HOME when configured).
The development and diagnostic builds use a separate profile/library.

Register Borges in your desktop's application menu, after putting the directory
where you want to keep it:

```sh
./dist/borges/launch --install-desktop
# Or register the chosen custom library:
./dist/borges/launch --library-root '/absolute/path/to/My Library' --install-desktop
```

Registration writes `$XDG_DATA_HOME/applications/borges.desktop` (normally
`~/.local/share/applications/borges.desktop`) and uses the icon in the application
directory. It does not set PDF/EPUB file associations. Run registration again after
moving the application or changing its configured library. It updates entries it
created and refuses to overwrite an unrelated existing Borges entry. To remove the
menu entry, delete that desktop file. Removing the application directory or desktop
entry does not remove the library.

## Library and reading

Use Import files… or Import folder… for DRM-free EPUBs and unencrypted PDFs.
Imports copy one file at a time, validate content and extract available metadata
and covers. Per-file summaries explain failures; Cancel retains completed imports.
Byte-identical live books are skipped. Matching title/author metadata asks whether
to Keep Both, Replace or Skip; Borges never silently merges different files.

Sections are nested logical groups. A book can belong to several sections without
extra file copies. Removing membership or deleting a section preserves its books.
Search matches title, author and subject in the selected view. Archive is independent
of reading status; opening a Finished or archived book for reference preserves both.
Finish is explicit. Start Rereading unarchives and restarts at the beginning.

Each book has its own reader window and saved position/sizing. Reopening a book
reuses its window and requests activation. Hyprland may show urgency instead of
focusing it; one click brings it forward. Closing the library leaves readers open;
use Open library in a reader. Closing the last window exits. Quit application saves
and closes all windows. Startup opens the library without reopening old readers.

| Control | Action |
| --- | --- |
| Right/Down, Left/Up on the reading surface | Next/previous page, without wrapping |
| `/` | Search the current book's existing text |
| Enter / Shift+Enter in search | Next/previous result |
| Esc | Close search and focus the reading surface |
| `:` | Jump to a physical PDF page or EPUB percentage, for example `50%` |
| Contents | PDF outline or EPUB chapters, when present |
| Zoom / Fit page | PDF or fixed-layout EPUB; pan within the current page |
| Font size | Reflowable EPUB; preserve the current passage |

Inputs, buttons, lists and dialogs keep ordinary keyboard behavior. You can select
and copy existing book text. External references show their address with an explicit
Copy Link action, without launching a browser or fetching the target. Images/fonts
must be local to the book. Book scripts and remote features are blocked.

Positions save automatically and the title line acknowledges commits. Pending and
failed saves remain visible. Retry saving retries the captured position. Close/Quit
waits for queued navigation and its save; on a save failure the default keeps the
reader open. Close without saving uses the last committed position. After an engine
failure use Retry reader, Replace file or Open library. Other readers remain usable
after a book-content process stops. Commands lost before reaching the application
cannot be recovered. A fallback location is explained when exact resume fails.

## Replacement and Trash

Replace File preserves organization, status/Archive and manual metadata. Its new
revision starts at the beginning; the previous file and position stay in Trash.
Deleting a book also keeps its bytes and state in Trash. Trash can restore a deleted
book, make an old revision current, or restore an independent Unread copy. Deleted
sections are not recreated; missing memberships may leave a book Unfiled.

Trash shows retained file sizes, including shared covers once. This is not a promise
of freed disk blocks. Empty Trash requires confirmation and permanently removes
eligible retained data, preserving live revisions and original import sources.
There is no automatic expiry. Failed purges remain visible/retryable; startup
continues an already confirmed purge. Partially purged entries cannot be restored.

## Manual backup and restore

1. Use Quit application and wait for every window/process to exit. Closing only the
   library is insufficient while readers remain. Do not copy a running library.
2. Copy the **entire library folder**, including hidden files and any SQLite
   `-wal`/`-shm` sidecars, books, covers, Trash and recovery files. Keep a separate
   untouched backup. The application directory/profile is not the library backup.
3. Restore by copying that folder to a new absolute path and starting a compatible
   Borges build with `launch --library-root '/absolute/path/to/restored-copy'`.
   Check metadata, sections, covers, reader positions, Archive and Trash before
   discarding the backup. Register that root again if you use the menu entry.

All durable paths are relative to the library. A closed copied root works
independently of its original. Schema upgrades first save a catalog snapshot under
`recovery/`; that snapshot is not a backup of book files. Newer/foreign/damaged
catalogs are refused visibly and preserved. Keep uncertain files and recovery
snapshots when investigating startup problems; there is no automatic destructive
repair. Missing managed files keep their entries and can be repaired with Replace
File or recovered from Trash/backup.

## Requirements and limits

This build targets x86-64 Arch Linux with a graphical session, coreutils and `/bin/sh`.
It bundles Electron, but still needs Arch's GTK3, NSS, libcups, ALSA, accessibility,
X11/XKB and Mesa/libdrm runtime libraries. Development checks use `gio` and
`desktop-file-validate` from glib2 and desktop-file-utils. The actual verified display
is Hyprland/Wayland at 1920×1080, scale 1. No compositor configuration change is needed.
The renderer sandbox must work; the launcher does not disable it. Chromium needs
available unprivileged user namespaces on this machine. Missing runtime libraries
or a restricted sandbox require fixing the host prerequisite before launch.

Supported documents are DRM-free EPUBs and unencrypted PDFs. Protected, corrupt,
unsupported or over-budget inputs are rejected individually with a reason. Import
validation bounds each file to 256 MiB/30 seconds, with further ZIP/XML/PDF parsing
bounds. There is no catalog entry cap. Missing optional metadata/cover uses fallbacks.
Image-only PDFs display normally but have no searchable text. OCR, conversion,
annotations, persistent highlights/bookmarks, cloud features and continuous/facing
pages are outside this version.

The created corpus covers reflowable/fixed-layout EPUB, ordinary font obfuscation,
EPUB 2/NCX/RTL, PDF geometry, images, links and book-length search. Arbitrary publisher
compatibility, other displays/scales, physical power loss and main/GPU recovery
are not established by those tests. See the source checkout's development evidence
for exact acceptance and 500-book measurements. This is a personal local build;
public/AUR/AppImage distribution is outside scope.
