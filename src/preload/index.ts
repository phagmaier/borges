import { contextBridge, ipcRenderer } from "electron";
import type {
  BorgesApi,
  DevelopmentApi,
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
    books: (query) => ipcRenderer.invoke("library:books", query),
    openBook: (bookId) => ipcRenderer.invoke("library:open-book", bookId),
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
