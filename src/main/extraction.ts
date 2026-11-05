import { stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, net, session } from "electron";
import {
  type ExtractedBook,
  type InspectBook,
  InspectionError,
} from "../library/extraction";
import { resolveServedAsset } from "./assets";

const MAX_INPUT = 256 * 1024 * 1024;
const MAX_WORKING_KIB = 512 * 1024;

/** A single import's disposable renderer, on its own session/origin, with no
 * preload or IPC assignment. It sees only bundled parsing assets and one
 * approved staged file. No book-controlled path is served by main. */
export function createBookInspector(rendererRoot: string): InspectBook {
  const isolated = session.fromPartition("import-inspector", {
    cache: false,
  });
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_, __, done) => done(false));
  isolated.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, done) => {
      const url = new URL(details.url);
      done({
        cancel:
          !(url.protocol === "borges:" && url.host === "extract") &&
          !details.url.startsWith("blob:borges://extract/"),
      });
    },
  );
  let busy = false;
  return async (stagedPath, format, signal) => {
    if (busy)
      throw new InspectionError(
        "resource-limit",
        "A content inspection is already running.",
      );
    busy = true;
    try {
      if (signal?.aborted)
        throw new InspectionError("cancelled", "Import cancelled.");
      if ((await stat(stagedPath)).size > MAX_INPUT)
        throw new InspectionError(
          "resource-limit",
          "The file exceeds the 256 MiB import parsing limit.",
        );
      await isolated.protocol.handle("borges", async (request) => {
        if (request.method !== "GET")
          return new Response(null, { status: 405 });
        if (request.url === "borges://extract/book")
          return net.fetch(pathToFileURL(stagedPath).href);
        const url = new URL(request.url);
        if (url.host !== "extract") return new Response(null, { status: 403 });
        url.host = "app";
        const asset = await resolveServedAsset(url.href, rendererRoot);
        if (asset) {
          const path = relative(rendererRoot, asset);
          if (
            path === "extract.html" ||
            path.startsWith(`assets${sep}`) ||
            path.startsWith(`reader-assets${sep}`)
          )
            return net.fetch(pathToFileURL(asset).href);
        }
        return new Response(null, { status: 403 });
      });
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          session: isolated,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      const contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.on("will-attach-webview", (event) => event.preventDefault());
      let timer: ReturnType<typeof setTimeout> | undefined;
      let memory: ReturnType<typeof setInterval> | undefined;
      let stop: (() => void) | undefined;
      let validated: ExtractedBook | undefined;
      try {
        const interrupted = new Promise<never>((_, reject) => {
          const fail = (
            code: "cancelled" | "resource-limit" | "invalid-content",
            message: string,
          ) => {
            reject(new InspectionError(code, message));
            if (!window.isDestroyed()) window.destroy();
          };
          stop = () => fail("cancelled", "Import cancelled.");
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) {
            stop();
            return;
          }
          timer = setTimeout(
            () =>
              fail(
                "resource-limit",
                "Content parsing exceeded the 30 second time limit.",
              ),
            30_000,
          );
          memory = setInterval(() => {
            if (contents.isDestroyed()) return;
            const pid = contents.getOSProcessId();
            const used =
              app.getAppMetrics().find((entry) => entry.pid === pid)?.memory
                .workingSetSize ?? 0;
            if (used > MAX_WORKING_KIB)
              fail(
                "resource-limit",
                "Content parsing exceeded the 512 MiB working memory limit.",
              );
          }, 250);
          contents.once("render-process-gone", () =>
            fail(
              "invalid-content",
              "The content parser stopped unexpectedly; no book was created.",
            ),
          );
        });
        const work = async () => {
          await window.loadURL("borges://extract/extract.html");
          const result = (await contents.executeJavaScript(
            `globalThis.inspectBook(${JSON.stringify(format)})`,
          )) as
            | { ok: true; value: ExtractedBook }
            | {
                ok: false;
                code: "protected" | "invalid-content" | "resource-limit";
                message: string;
              };
          if (!result.ok)
            throw new InspectionError(result.code, result.message);
          validated = result.value;
          const cover = (await contents.executeJavaScript(
            "globalThis.extractCover()",
          )) as { cover: Uint8Array | null; warnings: string[] };
          return {
            ...validated,
            cover: cover.cover,
            warnings: [...validated.warnings, ...cover.warnings],
          };
        };
        return await Promise.race([interrupted, work()]);
      } catch (error) {
        // A decoded-cover failure (including a wedged or crashed decoder) must
        // not turn already validated content into a failed book import.
        if (validated && !signal?.aborted)
          return {
            ...validated,
            cover: null,
            warnings: [
              ...validated.warnings,
              "Cover extraction stopped; a placeholder was used.",
            ],
          };
        throw error;
      } finally {
        clearTimeout(timer);
        clearInterval(memory);
        if (stop) signal?.removeEventListener("abort", stop);
        if (!window.isDestroyed()) window.destroy();
        // No on-disk cache/storage is used by this nonpersistent session.
      }
    } finally {
      isolated.protocol.unhandle("borges");
      busy = false;
    }
  };
}
