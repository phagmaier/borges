import type { DevelopmentWindow } from "./windows";

export interface RuntimeDatabaseInfo {
  sqlite: string;
  schemaVersion: number;
  launchCount: number;
  marker: string;
}

export interface RuntimeInfo {
  electron: string;
  chromium: string;
  node: string;
  sqlite: string;
  database: RuntimeDatabaseInfo;
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
