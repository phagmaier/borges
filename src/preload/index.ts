import { contextBridge, ipcRenderer } from "electron";
import type { DevelopmentApi } from "../shared/runtime";

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
