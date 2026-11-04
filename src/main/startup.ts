import { app, BrowserWindow } from "electron";

/** Available even when the catalog, normal renderer or application IPC fails. */
export async function showStartupFailure(
  error: unknown,
  root: string | undefined,
): Promise<BrowserWindow> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Borges cannot open its library: ${message}`);
  // Error text can contain filenames and catalog data. Render it only as text
  // in a scriptless, bridgeless window with no external resources/navigation.
  const escaped =
    `${root ? `Library folder: ${root}\n\n` : ""}${message}`.replace(
      /[&<>]/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ?? character,
    );
  const window = new BrowserWindow({
    title: "Borges — startup problem",
    width: 760,
    height: 520,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) =>
    event.preventDefault(),
  );
  window.on("closed", () => app.exit(1));
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Borges — startup problem</title>
<style>
:root { color-scheme: light dark; font: 16px/1.6 system-ui, sans-serif; }
body { margin: 0; padding: 32px; }
main { max-width: 680px; margin: auto; }
h1 { font-size: 1.5rem; line-height: 1.3; }
.problem { padding: 16px; border: 1px solid GrayText; white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head><body><main>
<h1>Borges cannot open its library</h1>
<p class="problem">${escaped}</p>
<p>Close this window, resolve the problem above, then reopen Borges.</p>
<p>Keep your library files and any recovery snapshots while investigating.</p>
</main></body></html>`)}`,
  );
  window.show();
  window.focus();
  return window;
}
