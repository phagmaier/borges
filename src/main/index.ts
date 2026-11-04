import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, ipcMain, net, protocol, session } from "electron";
import {
  type ReconciliationReport,
  reconcileOperations,
} from "../library/recovery";
import type { CatalogInfo, RuntimeInfo } from "../shared/runtime";
import { type Library, openLibrary } from "../storage/catalog";
import { resolveLibraryRoot } from "../storage/paths";
import { resolveServedAsset } from "./assets";
import { WindowCoordinator } from "./windows";

const directory = fileURLToPath(new URL(".", import.meta.url));
const rendererRoot = resolve(directory, "../renderer");
const developmentUrl = app.isPackaged
  ? undefined
  : process.env.ELECTRON_RENDERER_URL;
const shellUrl = developmentUrl ?? "borges://app/index.html";
const windows = new WindowCoordinator(
  shellUrl,
  join(directory, "../preload/index.cjs"),
);

// The setup shell uses a separate profile and never opens the user's library.
app.setPath(
  "userData",
  resolve(
    process.env.BORGES_DEV_PROFILE ??
      join(app.getPath("appData"), "borges-development"),
  ),
);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "borges",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let library: Library | undefined;

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
): Promise<ReconciliationReport | null> {
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
    return report;
  } catch (error) {
    console.error(
      `Interrupted operations could not be reconciled; they are kept for the next start (${error instanceof Error ? error.message : String(error)}).`,
    );
    return null;
  }
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => windows.beginQuit());
// Closing the catalog checkpoints its WAL and releases the root lock.
app.on("will-quit", () => library?.close());

// The profile scopes Electron's single-instance lock, which routes ordinary
// second launches. The library-root lock excludes any other build or profile.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    app
      .whenReady()
      .then(() => windows.openLibrary())
      .catch(console.error);
  });
  app.on("activate", () => {
    windows.openLibrary().catch(console.error);
  });
  app
    .whenReady()
    .then(async () => {
      try {
        library = openConfiguredLibrary();
      } catch (error) {
        console.error(
          `Borges cannot open its library: ${error instanceof Error ? error.message : String(error)}`,
        );
        app.exit(1);
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
      const catalog = catalogInfo(library, await reconcile(library));
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
          await windows.openReader(bookId);
        },
      );
      ipcMain.handle("development:open-library", async (event) => {
        windows.identityFor(event);
        await windows.openLibrary();
      });
      ipcMain.handle("development:quit", (event) => {
        windows.identityFor(event);
        // Let the invoke acknowledge before destroying its sender.
        setImmediate(() => app.quit());
      });
      await windows.openLibrary();
    })
    .catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
}
