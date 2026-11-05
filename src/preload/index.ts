import { contextBridge, ipcRenderer } from "electron";
import type {
  BorgesApi,
  DevelopmentApi,
  ImportProgress,
  ProgressResult,
} from "../shared/runtime";

const development: DevelopmentApi = {
  getWindowInfo: () => ipcRenderer.invoke("development:window"),
  openReader: (bookId) => ipcRenderer.invoke("development:open-reader", bookId),
  openLibrary: () => ipcRenderer.invoke("development:open-library"),
  quit: () => ipcRenderer.invoke("development:quit"),
  getRuntimeInfo: async () => ({
    ...(await ipcRenderer.invoke("development:runtime")),
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
  }),
};
contextBridge.exposeInMainWorld("development", development);

const borges: BorgesApi = {
  library: {
    startupProblems: () => ipcRenderer.invoke("library:startup-problems"),
    books: (query) => ipcRenderer.invoke("library:books", query),
    filterTerms: (query) => ipcRenderer.invoke("library:filter-terms", query),
    sections: (options) => ipcRenderer.invoke("library:sections", options),
    createSection: (name, parentId) =>
      ipcRenderer.invoke("library:create-section", name, parentId),
    renameSection: (sectionId, name) =>
      ipcRenderer.invoke("library:rename-section", sectionId, name),
    moveSection: (sectionId, parentId) =>
      ipcRenderer.invoke("library:move-section", sectionId, parentId),
    previewSectionDeletion: (sectionId) =>
      ipcRenderer.invoke("library:preview-section-deletion", sectionId),
    deleteSection: (sectionId) =>
      ipcRenderer.invoke("library:delete-section", sectionId),
    addToSection: (sectionId, bookIds) =>
      ipcRenderer.invoke("library:add-to-section", sectionId, bookIds),
    removeFromSection: (sectionId, bookIds) =>
      ipcRenderer.invoke("library:remove-from-section", sectionId, bookIds),
    finish: (bookId) => ipcRenderer.invoke("library:finish", bookId),
    archive: (bookId) => ipcRenderer.invoke("library:archive", bookId),
    unarchive: (bookId) => ipcRenderer.invoke("library:unarchive", bookId),
    startRereading: (bookId) =>
      ipcRenderer.invoke("library:start-rereading", bookId),
    editMetadata: (bookId, edit) =>
      ipcRenderer.invoke("library:edit-metadata", bookId, edit),
    chooseCover: (bookId) => ipcRenderer.invoke("library:choose-cover", bookId),
    replaceFile: (bookId) => ipcRenderer.invoke("library:replace-file", bookId),
    cover: (bookId, token) =>
      ipcRenderer.invoke("library:cover", bookId, token),
    importBooks: (kind, sectionId) =>
      ipcRenderer.invoke("library:import", kind, sectionId),
    cancelImport: () => ipcRenderer.invoke("library:cancel-import"),
    onImportProgress(listener) {
      const handler = (_: unknown, progress: ImportProgress) =>
        listener(progress);
      ipcRenderer.on("library:import-progress", handler);
      return () => ipcRenderer.off("library:import-progress", handler);
    },
    openBook: (bookId) => ipcRenderer.invoke("library:open-book", bookId),
    onChanged(listener) {
      const handler = () => listener();
      ipcRenderer.on("library:changed", handler);
      return () => ipcRenderer.off("library:changed", handler);
    },
  },
  reader: {
    openBook: () => ipcRenderer.invoke("reader:open-book"),
    reportProgress: (report) => ipcRenderer.send("reader:progress", report),
    bookOpened: (bookId, generation) =>
      ipcRenderer.invoke("reader:opened", bookId, generation),
    onProgressResult(listener) {
      const handler = (_: unknown, result: ProgressResult) => listener(result);
      ipcRenderer.on("reader:progress-result", handler);
      return () => ipcRenderer.off("reader:progress-result", handler);
    },
  },
};
contextBridge.exposeInMainWorld("borges", borges);
