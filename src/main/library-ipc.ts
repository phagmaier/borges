import type { DatabaseSync } from "node:sqlite";
import {
  BrowserWindow,
  dialog,
  type IpcMain,
  type IpcMainInvokeEvent,
} from "electron";
import {
  archiveBook,
  editMetadata,
  markFinished,
  startRereading,
  unarchiveBook,
} from "../library/books.ts";
import { readCover, setManualCover } from "../library/covers.ts";
import { countOutcomes, importBatch } from "../library/import-batch.ts";
import {
  getBook,
  listFilterTerms,
  listSections,
  queryBooks,
} from "../library/query.ts";
import { LibraryError } from "../library/rules.ts";
import {
  addBooksToSection,
  createSection,
  deleteSection,
  moveSection,
  previewSectionDeletion,
  removeBooksFromSection,
  renameSection,
} from "../library/sections.ts";
import type { LibraryResult } from "../shared/runtime.ts";
import { normalizeCover } from "./cover-image.ts";
import type { ReaderSessions } from "./sessions.ts";
import type { WindowCoordinator } from "./windows.ts";

/** Channel sent to the library window after any catalog change. */
export const LIBRARY_CHANGED = "library:changed";
/** Progress of the running import batch, sent to the library window. */
export const IMPORT_PROGRESS = "library:import-progress";

interface Dependencies {
  /** Development-only delay after each copied import chunk, in ms. */
  importChunkDelayMs?: number;
  ipcMain: IpcMain;
  database: DatabaseSync;
  root: string;
  windows: WindowCoordinator;
  readers: ReaderSessions;
  startupProblems: string[];
}

/**
 * Library-window requests over the M2-04 service. Every argument is untrusted
 * and validated by the service. Only the library window may call these; a
 * service failure is returned as a typed result rather than thrown.
 */
export function registerLibraryIpc({
  ipcMain,
  database,
  root,
  windows,
  readers,
  startupProblems,
  importChunkDelayMs = 0,
}: Dependencies): { changed(): void } {
  const changed = () => {
    const library = windows.library();
    if (library && !library.isDestroyed()) library.send(LIBRARY_CHANGED);
  };

  function handle(
    channel: string,
    run: (...args: unknown[]) => unknown,
    options: { mutates?: boolean } = {},
  ) {
    ipcMain.handle(
      `library:${channel}`,
      async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (windows.identityFor(event).kind !== "library")
          throw new Error("Only the library window may do this.");
        let result: LibraryResult<unknown>;
        try {
          result = { ok: true, value: (await run(...args)) ?? null };
        } catch (error) {
          result =
            error instanceof LibraryError
              ? { ok: false, code: error.code, message: error.message }
              : {
                  ok: false,
                  code: "failed",
                  message:
                    error instanceof Error ? error.message : String(error),
                };
        }
        if (result.ok && options.mutates) changed();
        return result;
      },
    );
  }
  const mutates = { mutates: true };
  handle("startup-problems", () => startupProblems);
  const fields = (input: unknown) => (input ?? {}) as Record<string, unknown>;

  handle("cover", (bookId, token) =>
    readCover({ root, database }, bookId, token),
  );
  let choosingCover = false;
  handle("choose-cover", async (bookId) => {
    const book = getBook(database, bookId as string);
    if (choosingCover)
      throw new LibraryError("invalid", "A cover chooser is already open.");
    const contents = windows.library();
    const parent = contents && BrowserWindow.fromWebContents(contents);
    if (!parent) throw new Error("The library window is closed.");
    choosingCover = true;
    try {
      const choice = await dialog.showOpenDialog(parent, {
        title: `Choose cover for ${book.title}`,
        properties: ["openFile"],
        filters: [
          {
            name: "Cover images (PNG, JPEG)",
            extensions: ["png", "jpg", "jpeg"],
          },
        ],
      });
      if (choice.canceled || !choice.filePaths[0]) return null;
      await setManualCover({ root, database }, book.id, choice.filePaths[0], {
        normalize: normalizeCover,
      });
      changed();
      return getBook(database, book.id);
    } finally {
      choosingCover = false;
    }
  });

  // One import batch at a time, tied to the library page that started it:
  // closing or reloading that page cancels the batch (completed books stay).
  let importing: AbortController | null = null;
  handle("import", async (kind, sectionId) => {
    if (kind !== "files" && kind !== "folders")
      throw new LibraryError("invalid", "Choose files or folders to import.");
    if (importing)
      throw new LibraryError("invalid", "An import is already running.");
    // importBatch validates the section again after the dialog.
    if (
      sectionId != null &&
      (typeof sectionId !== "string" ||
        !database.prepare("SELECT 1 FROM sections WHERE id = ?").get(sectionId))
    )
      throw new LibraryError(
        "unknown-section",
        "The section to import into no longer exists.",
      );
    const contents = windows.library();
    const parent = contents && BrowserWindow.fromWebContents(contents);
    if (!contents || !parent) throw new Error("The library window is closed.");
    const controller = new AbortController();
    importing = controller;
    const stop = () => controller.abort();
    const onNavigation = (details: {
      isMainFrame: boolean;
      isSameDocument: boolean;
    }) => {
      if (details.isMainFrame && !details.isSameDocument) stop();
    };
    contents.once("destroyed", stop);
    contents.on("did-start-navigation", onNavigation);
    try {
      const choice = await dialog.showOpenDialog(parent, {
        title:
          kind === "files"
            ? "Import PDF and EPUB files"
            : "Import folders of PDF and EPUB files",
        properties:
          kind === "files"
            ? ["openFile", "multiSelections"]
            : ["openDirectory", "multiSelections"],
        ...(kind === "files"
          ? {
              filters: [
                {
                  name: "Books (PDF, EPUB)",
                  extensions: ["pdf", "epub", "PDF", "EPUB"],
                },
                { name: "All files", extensions: ["*"] },
              ],
            }
          : {}),
      });
      // A page closed or reloaded while choosing has nobody to report to.
      if (
        choice.canceled ||
        choice.filePaths.length === 0 ||
        controller.signal.aborted
      )
        return null;
      const summary = await importBatch({ root, database }, choice.filePaths, {
        sectionId: (sectionId as string | null | undefined) ?? null,
        signal: controller.signal,
        onProgress(progress) {
          if (!contents.isDestroyed()) contents.send(IMPORT_PROGRESS, progress);
        },
        onImported: changed,
        ...(importChunkDelayMs > 0
          ? {
              pace: () =>
                new Promise<void>((resolve) =>
                  setTimeout(resolve, importChunkDelayMs),
                ),
            }
          : {}),
      });
      const counts = countOutcomes(summary);
      console.info(
        `Import finished: ${Object.entries(counts)
          .map(([kind, count]) => `${count} ${kind}`)
          .join(", ")}.`,
      );
      return summary;
    } finally {
      importing = null;
      if (!contents.isDestroyed()) {
        contents.off("destroyed", stop);
        contents.off("did-start-navigation", onNavigation);
      }
    }
  });
  handle("cancel-import", () => {
    importing?.abort();
    return importing !== null;
  });

  handle("books", (query) =>
    queryBooks(database, query ?? { view: { kind: "all" } }),
  );
  handle("filter-terms", (query) => listFilterTerms(database, query));
  handle("sections", (input) =>
    listSections(database, {
      includeArchived: fields(input).includeArchived === true,
    }),
  );
  handle(
    "create-section",
    (name, parentId) => createSection(database, { name, parentId }),
    mutates,
  );
  handle(
    "rename-section",
    (sectionId, name) => renameSection(database, sectionId, name),
    mutates,
  );
  handle(
    "move-section",
    (sectionId, parentId) => moveSection(database, sectionId, parentId),
    mutates,
  );
  handle("preview-section-deletion", (sectionId) =>
    previewSectionDeletion(database, sectionId),
  );
  handle(
    "delete-section",
    (sectionId) => deleteSection(database, sectionId),
    mutates,
  );
  handle(
    "add-to-section",
    (sectionId, bookIds) => addBooksToSection(database, sectionId, bookIds),
    mutates,
  );
  handle(
    "remove-from-section",
    (sectionId, bookIds) =>
      removeBooksFromSection(database, sectionId, bookIds),
    mutates,
  );
  handle("finish", (bookId) => markFinished(database, bookId), mutates);
  handle("archive", (bookId) => archiveBook(database, bookId), mutates);
  handle("unarchive", (bookId) => unarchiveBook(database, bookId), mutates);
  handle(
    "start-rereading",
    (bookId) => {
      // Quiesce an open reader first: flush and retire its session, so no
      // message from the old page can write after the reset. Then reload it,
      // which starts a new session at the beginning (or, if the reset
      // failed, resumes the unchanged position with a live session).
      const book = getBook(database, bookId as string);
      const reader = windows.catalogReader(book.id);
      if (reader) readers.end(reader.id);
      try {
        return startRereading(database, book.id);
      } finally {
        if (reader && !reader.isDestroyed()) reader.reload();
      }
    },
    mutates,
  );
  handle(
    "edit-metadata",
    (bookId, edit) => editMetadata(database, bookId, edit),
    mutates,
  );
  handle("open-book", async (bookId) => {
    const book = getBook(database, bookId as string);
    await windows.openCatalogReader(book);
  });

  return { changed };
}
