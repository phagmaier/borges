import type { DevelopmentWindow } from "./windows";

export interface CatalogInfo {
  sqlite: string;
  schemaVersion: number;
  libraryId: string;
  root: string;
  created: boolean;
  upgradedFrom: number | null;
  /** Process ID named by a stale lock record replaced at startup. */
  recoveredStaleLockPid: number | null;
  /** Startup reconciliation of interrupted file/catalog operations. */
  reconciliation: {
    rolledBack: number;
    retained: number;
    unrecognized: number;
  } | null;
}

export interface RuntimeInfo {
  electron: string;
  chromium: string;
  node: string;
  sqlite: string;
  catalog: CatalogInfo;
}

export interface RendererRuntimeInfo extends RuntimeInfo {
  sandboxed: boolean;
  contextIsolated: boolean;
}

export interface DevelopmentApi {
  getRuntimeInfo(): Promise<RendererRuntimeInfo>;
  getWindowInfo(): Promise<DevelopmentWindow>;
  openReader(bookId: string): Promise<void>;
  openLibrary(): Promise<void>;
  quit(): Promise<void>;
}
