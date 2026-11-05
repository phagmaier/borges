import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  protocol,
  session,
  webContents,
} from "electron";
import { getBook } from "../library/query";
import {
  type ReconciliationReport,
  reconcileOperations,
} from "../library/recovery";
import { externalLink } from "../shared/links";
import type { CatalogInfo, OpenedBook, RuntimeInfo } from "../shared/runtime";
import { type Library, openLibrary } from "../storage/catalog";
import {
  resolveExistingLibraryPath,
  resolveLibraryRoot,
} from "../storage/paths";
import { resolveServedAsset } from "./assets";
import { createBookInspector } from "./extraction";
import { registerLibraryIpc } from "./library-ipc";
import { ReaderDrain } from "./reader-drain";
import { ReaderSessions } from "./sessions";
import { showStartupFailure } from "./startup";
import { WindowCoordinator } from "./windows";

const directory = fileURLToPath(new URL(".", import.meta.url));
const diagnostic = !app.isPackaged || app.getName() === "borges-runtime-check";
if (!diagnostic) {
  app.setName("Borges");
  app.setDesktopName("borges.desktop");
}
const rendererRoot = resolve(directory, "../renderer");
const developmentUrl = app.isPackaged
  ? undefined
  : process.env.ELECTRON_RENDERER_URL;
const shellUrl = developmentUrl ?? "borges://app/index.html";
let sessions: ReaderSessions | undefined;
const readerDrain = new ReaderDrain();
const windows = new WindowCoordinator(
  shellUrl,
  join(directory, "../preload/index.cjs"),
  (owner) => sessions?.end(owner),
  prepareReaderClose,
  async (owner) => {
    const contents = webContents.fromId(owner);
    if (contents && !contents.isDestroyed() && sessions?.sessionOf(owner))
      await readerDrain.request(contents);
  },
  diagnostic,
);

// The setup shell uses a separate profile and never opens the user's library.
app.setPath(
  "userData",
  resolve(
    (diagnostic ? process.env.BORGES_DEV_PROFILE : undefined) ??
      join(
        app.getPath("appData"),
        diagnostic ? "borges-development" : "borges",
      ),
  ),
);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "borges",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let library: Library | undefined;
let configuredLibraryRoot: string | undefined;
let startupFailure: BrowserWindow | undefined;

function catalogInfo(
  opened: Library,
  report: ReconciliationReport | null,
): CatalogInfo {
  const sqlite = opened.database
    .prepare("SELECT sqlite_version() AS version")
    .get()?.version;
  return {
    sqlite: String(sqlite),
    schemaVersion: opened.schemaVersion,
    libraryId: opened.libraryId,
    root: opened.root,
    created: opened.created,
    upgradedFrom: opened.upgrade?.from ?? null,
    recoveredStaleLockPid: opened.recoveredStaleLock?.pid ?? null,
    reconciliation: report && {
      rolledBack: report.operations.filter((o) => o.outcome === "rolled-back")
        .length,
      retained: report.operations.filter((o) => o.outcome === "retained")
        .length,
      unrecognized: report.unrecognized.length,
    },
  };
}

function runtimeInfo(catalog: CatalogInfo): RuntimeInfo {
  return {
    diagnostic,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    sqlite: catalog.sqlite,
    catalog,
  };
}

/** Lock and open the configured library before any window can request work. */
function openConfiguredLibrary(): Library {
  const root = resolveLibraryRoot({
    explicitRoot: process.env.BORGES_LIBRARY_ROOT,
    xdgDataHome: process.env.XDG_DATA_HOME,
    home: app.getPath("home"),
    // Unpackaged development builds never open the user's real library.
    developmentProfile: app.isPackaged ? undefined : app.getPath("userData"),
  });
  configuredLibraryRoot = root;
  const opened = openLibrary({ root });
  if (opened.recoveredStaleLock) {
    console.warn(
      `Recovered the library lock left by exited process ${opened.recoveredStaleLock.pid}.`,
    );
  }
  if (opened.upgrade) {
    console.info(
      `Upgraded the catalog from schema ${opened.upgrade.from} to ${opened.upgrade.to}; snapshot: ${opened.upgrade.snapshot}`,
    );
  }
  return opened;
}

/**
 * Settle interrupted imports before any window can start new work. A failure
 * here leaves the records open for the next startup; the library still opens.
 */
async function reconcile(
  opened: Library,
): Promise<{ report: ReconciliationReport | null; problems: string[] }> {
  try {
    const report = await reconcileOperations(opened);
    for (const operation of report.operations) {
      (operation.outcome === "retained" ? console.warn : console.info)(
        operation.message,
      );
    }
    if (report.unrecognized.length > 0) {
      console.warn(
        `Kept unrecognized managed files for inspection: ${report.unrecognized.join(", ")}`,
      );
    }
    return {
      report,
      problems: [
        ...report.operations
          .filter((operation) => operation.outcome === "retained")
          .map((operation) =>
            [operation.message, ...operation.retained].join("\n"),
          ),
        ...report.unrecognized.map(
          (path) => `Unrecognized managed file kept for inspection: ${path}`,
        ),
      ],
    };
  } catch (error) {
    const message = `Interrupted operations could not be reconciled; unresolved records and files are kept for the next start (${error instanceof Error ? error.message : String(error)}).`;
    console.error(message);
    return { report: null, problems: [message] };
  }
}

/** The catalog book assigned to the sending reader window, or an error. */
function assignedCatalogBook(event: IpcMainInvokeEvent | IpcMainEvent): string {
  const identity = windows.identityFor(event);
  if (identity.kind !== "reader" || identity.book.source !== "catalog")
    throw new Error("Only a catalog reader window may do this.");
  return identity.book.id;
}

async function openAssignedBook(
  opened: Library,
  readers: ReaderSessions,
  event: IpcMainInvokeEvent,
): Promise<OpenedBook> {
  const bookId = assignedCatalogBook(event);
  const owner = event.sender.id;
  const book = getBook(opened.database, bookId);
  const grant = readers.begin(owner, bookId);
  const revision = opened.database
    .prepare("SELECT path, original_filename FROM revisions WHERE id = ?")
    .get(grant.revisionId) as { path: string; original_filename: string };
  try {
    const bytes = await readFile(
      await resolveExistingLibraryPath(opened.root, revision.path),
    );
    // A reload or close during the read retires this grant; hand out nothing.
    if (readers.sessionOf(owner)?.generation !== grant.generation)
      throw new Error("This reader session was replaced while opening.");
    return {
      ...grant,
      title: book.title,
      fileName: revision.original_filename,
      bytes,
    };
  } catch (error) {
    if (readers.sessionOf(owner)?.generation === grant.generation)
      readers.end(owner);
    throw new Error(
      `${book.title} could not be read from the library (${error instanceof Error ? error.message : String(error)}). Its catalog entry is unchanged.`,
    );
  }
}

app.on("window-all-closed", () => app.quit());
let quitReady = false;
let preparingQuit = false;
const suspendedReaders = new Set<number>();
app.on("before-quit", (event) => {
  if (quitReady || !sessions) return;
  event.preventDefault();
  if (preparingQuit) return;
  preparingQuit = true;
  void windows
    .prepareQuit()
    .then((ready) => {
      if (!ready) return;
      windows.beginQuit();
      sessions?.endAll();
      quitReady = true;
      app.quit();
    })
    .catch(console.error)
    .finally(() => {
      for (const owner of suspendedReaders) {
        const contents = webContents.fromId(owner);
        if (!quitReady && contents && !contents.isDestroyed())
          contents.send("reader:resume");
      }
      suspendedReaders.clear();
      preparingQuit = false;
    });
});

async function prepareReaderClose(owner: number): Promise<boolean> {
  const contents = webContents.fromId(owner);
  if (!contents || contents.isDestroyed() || !sessions?.sessionOf(owner))
    return true;
  try {
    await readerDrain.request(contents);
    sessions.flush(owner);
    return true;
  } catch (error) {
    const choice = await dialog.showMessageBox({
      type: "warning",
      title: "Position not saved",
      message: "The reader's latest position could not be saved.",
      detail: `${error instanceof Error ? error.message : String(error)}\nKeep the reader open to retry saving, or close using the last committed position.`,
      buttons: ["Keep reader open", "Close without saving"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 1;
  } finally {
    if (preparingQuit) suspendedReaders.add(owner);
    else if (!contents.isDestroyed()) contents.send("reader:resume");
  }
}
// Closing the catalog checkpoints its WAL and releases the root lock.
app.on("will-quit", () => library?.close());

// The profile scopes Electron's single-instance lock, which routes ordinary
// second launches. The library-root lock excludes any other build or profile.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const activateLibrary = async () => {
    if (startupFailure && !startupFailure.isDestroyed()) {
      if (startupFailure.isMinimized()) startupFailure.restore();
      startupFailure.show();
      startupFailure.focus();
    } else if (sessions) {
      await windows.openLibrary();
    }
  };
  app.on("second-instance", () => {
    app.whenReady().then(activateLibrary).catch(console.error);
  });
  app.on("activate", () => {
    activateLibrary().catch(console.error);
  });
  app
    .whenReady()
    .then(async () => {
      try {
        library = openConfiguredLibrary();
      } catch (error) {
        startupFailure = await showStartupFailure(error, configuredLibraryRoot);
        return;
      }
      if (
        developmentUrl &&
        !["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(developmentUrl).hostname,
        )
      ) {
        throw new Error("The development server must use loopback networking.");
      }
      protocol.handle("borges", async (request) => {
        if (request.method !== "GET")
          return new Response(null, { status: 405 });
        const path = await resolveServedAsset(request.url, rendererRoot);
        if (!path) return new Response(null, { status: 403 });
        try {
          return await net.fetch(pathToFileURL(path).href);
        } catch {
          return new Response(null, { status: 404 });
        }
      });
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.setPermissionRequestHandler((_, __, callback) =>
        callback(false),
      );
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
        (details, callback) => {
          const url = new URL(details.url);
          const dev = developmentUrl ? new URL(developmentUrl) : null;
          const isLocalDev =
            dev !== null &&
            url.host === dev.host &&
            (url.protocol === dev.protocol ||
              (dev.protocol === "http:" && url.protocol === "ws:"));
          callback({ cancel: !isLocalDev });
        },
      );
      // Content/network boundaries above are in place before the first await;
      // windows open only after interrupted operations are settled.
      const reconciliation = await reconcile(library);
      const catalog = catalogInfo(library, reconciliation.report);
      ipcMain.handle("development:runtime", (event) => {
        windows.identityFor(event);
        return runtimeInfo(catalog);
      });
      ipcMain.handle("development:window", (event) =>
        windows.identityFor(event),
      );
      ipcMain.handle(
        "development:open-reader",
        async (event, bookId: unknown) => {
          if (windows.identityFor(event).kind !== "library") {
            throw new Error("Readers must be opened from the library.");
          }
          if (!diagnostic)
            throw new Error(
              "Diagnostic books are unavailable in the personal application.",
            );
          await windows.openReader(bookId);
        },
      );
      ipcMain.handle("development:open-library", async (event) => {
        windows.identityFor(event);
        await windows.openLibrary();
      });
      const opened = library;
      const interval = Number(process.env.BORGES_SAVE_INTERVAL_MS);
      const readers = new ReaderSessions(
        opened.database,
        (owner, result) => {
          const target = webContents.fromId(owner);
          if (target && !target.isDestroyed())
            target.send("reader:progress-result", result);
        },
        // Tests may lengthen the coalescing interval in development builds to
        // prove that close/Quit flush rather than the timer saved a position.
        !app.isPackaged && interval > 0 ? { delayMs: interval } : {},
      );
      sessions = readers;
      const libraryRequests = registerLibraryIpc({
        inspectBook: createBookInspector(rendererRoot),
        ipcMain,
        database: opened.database,
        root: opened.root,
        windows,
        readers,
        startupProblems: reconciliation.problems,
        // Native cancellation tests slow copying in development builds only.
        importChunkDelayMs: app.isPackaged
          ? 0
          : Number(process.env.BORGES_IMPORT_CHUNK_DELAY_MS) || 0,
      });
      ipcMain.handle("reader:open-book", (event) =>
        openAssignedBook(opened, readers, event),
      );
      ipcMain.on("reader:drained", (event, token: unknown) => {
        try {
          assignedCatalogBook(event);
        } catch {
          return;
        }
        readerDrain.complete(event.sender.id, token);
      });
      ipcMain.handle("reader:flush", async (event) => {
        assignedCatalogBook(event);
        try {
          await readerDrain.request(event.sender);
          readers.flush(event.sender.id);
        } finally {
          if (!event.sender.isDestroyed()) event.sender.send("reader:resume");
        }
      });
      ipcMain.handle("reader:copy-link", (event, address: unknown) => {
        if (windows.identityFor(event).kind !== "reader")
          throw new Error("Only a reader window may copy a reference.");
        const link = externalLink(address);
        if (!link) throw new Error("Invalid external reference.");
        clipboard.writeText(link);
      });
      ipcMain.on("reader:progress", (event, report: unknown) => {
        let owner: number;
        try {
          windows.identityFor(event);
          owner = event.sender.id;
        } catch {
          return; // Not a registered application window: no reply channel.
        }
        // Binding to the window's own session happens inside `report`.
        readers.report(owner, report);
      });
      ipcMain.handle(
        "reader:opened",
        (event, bookId: unknown, generation: unknown) => {
          assignedCatalogBook(event);
          readers.opened(event.sender.id, bookId, generation);
          libraryRequests.changed(); // An unread book may now be Currently Reading.
        },
      );
      ipcMain.handle("development:quit", (event) => {
        windows.identityFor(event);
        // Let the invoke acknowledge before destroying its sender.
        setImmediate(() => app.quit());
      });
      await windows.openLibrary();
    })
    .catch(async (error: unknown) => {
      try {
        startupFailure = await showStartupFailure(error, configuredLibraryRoot);
      } catch (windowError) {
        console.error(windowError);
        app.exit(1);
      }
    });
}
