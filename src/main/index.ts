import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, ipcMain, net, protocol, session } from "electron";
import type { RuntimeDatabaseInfo, RuntimeInfo } from "../shared/runtime";
import { resolveServedAsset } from "./assets";
import { recordRuntimeLaunch } from "./runtime-database";
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

function runtimeInfo(database: RuntimeDatabaseInfo): RuntimeInfo {
  return {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    sqlite: database.sqlite,
    database,
  };
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => windows.beginQuit());

// The development profile scopes Electron's single-instance lock. The future
// catalog additionally needs an exclusive lock on the configured library root.
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
      const database = recordRuntimeLaunch(
        join(app.getPath("userData"), "runtime-check.sqlite"),
      );
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
      ipcMain.handle("development:runtime", (event) => {
        windows.identityFor(event);
        return runtimeInfo(database);
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
