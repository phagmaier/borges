import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  type DevelopmentWindow,
  developmentBooks,
  engineUrl,
} from "../shared/windows";

interface WindowEntry {
  window: BrowserWindow;
  identity: DevelopmentWindow;
  ready: Promise<void>;
}

// Own identity and pending opens before loading starts, so concurrent requests
// cannot create duplicate windows. Progress lives in ReaderSessions; this
// coordinator reports reader-window closure to it by webContents ID.
export class WindowCoordinator {
  private readonly entries = new Map<string, WindowEntry>();
  private quitting = false;

  constructor(
    private readonly shellUrl: string,
    private readonly preloadPath: string,
    private readonly onReaderClosed: (owner: number) => void = () => {},
  ) {}

  beginQuit(): void {
    this.quitting = true;
  }

  identityFor(event: IpcMainInvokeEvent | IpcMainEvent): DevelopmentWindow {
    const entry = [...this.entries.values()].find(
      ({ window }) => window.webContents === event.sender,
    );
    if (
      this.quitting ||
      !entry ||
      event.senderFrame !== event.sender.mainFrame ||
      !this.isShellUrl(event.senderFrame.url)
    ) {
      throw new Error("This request requires a registered application window.");
    }
    return entry.identity;
  }

  async openLibrary(): Promise<void> {
    await this.open("library", { kind: "library" });
  }

  async openReader(bookId: unknown): Promise<void> {
    const book = developmentBooks.find((candidate) => candidate.id === bookId);
    if (!book) throw new Error("Unknown diagnostic book.");
    await this.open(`reader:${book.id}`, {
      kind: "reader",
      book: { ...book, source: "fixture" },
    });
  }

  /** Open or focus the one reader for a catalog book (already validated). */
  async openCatalogReader(book: { id: string; title: string }): Promise<void> {
    await this.open(`catalog:${book.id}`, {
      kind: "reader",
      book: { id: book.id, title: book.title, source: "catalog" },
    });
  }

  private isShellUrl(destination: string): boolean {
    try {
      const target = new URL(destination);
      const shell = new URL(this.shellUrl);
      target.hash = "";
      shell.hash = "";
      return target.href === shell.href;
    } catch {
      return false;
    }
  }

  private async open(key: string, identity: DevelopmentWindow): Promise<void> {
    if (this.quitting) throw new Error("The application is quitting.");
    let entry = this.entries.get(key);
    if (!entry) {
      const window = new BrowserWindow({
        title:
          identity.kind === "library"
            ? "Borges — development"
            : `${identity.book.title} — reader shell`,
        width: 1000,
        height: 720,
        show: false,
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      entry = { window, identity, ready: Promise.resolve() };
      this.entries.set(key, entry);
      window.removeMenu();
      window.on("page-title-updated", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-frame-navigate", (event) => {
        // Only the registered shell may load its assigned engine. Only that
        // engine may create chapter frames. Book documents cannot navigate
        // themselves, their ancestors, or siblings into another origin/role.
        const engine =
          identity.kind === "reader" ? engineUrl(identity.book) : null;
        const initiator = event.initiator;
        const allowed = event.isMainFrame
          ? this.isShellUrl(event.url) &&
            (!initiator || initiator === window.webContents.mainFrame)
          : engine !== null &&
            ((event.url === engine &&
              event.frame?.parent === window.webContents.mainFrame &&
              (!initiator ||
                initiator === window.webContents.mainFrame ||
                initiator.url === engine)) ||
              (event.url.startsWith("blob:borges://reader/") &&
                event.frame?.parent?.url === engine &&
                initiator?.url === engine));
        if (!allowed) event.preventDefault();
      });
      const owner = window.webContents.id;
      window.on("closed", () => {
        if (this.entries.get(key)?.window === window) this.entries.delete(key);
        if (identity.kind === "reader") this.onReaderClosed(owner);
      });
      entry.ready = window.loadURL(this.shellUrl).catch((error: unknown) => {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      });
    }
    await entry.ready;
    if (entry.window.isDestroyed() || this.quitting) return;
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    entry.window.focus();
  }
}
