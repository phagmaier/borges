import type { StoredSizing } from "../library/progress";
import type { BookSummary } from "../library/query";
import type { ProgressResult } from "../main/sessions";
import type { ReaderLocation, ReaderSizing } from "../readers/session";
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

export type { BookSummary } from "../library/query";
export type { ProgressResult } from "../main/sessions";

/** What a catalog reader window receives for its assigned book. */
export interface OpenedBook {
  bookId: string;
  revisionId: string;
  format: "pdf" | "epub";
  generation: number;
  title: string;
  fileName: string;
  location: ReaderLocation | null;
  sizing: StoredSizing;
  bytes: Uint8Array;
}

export interface ProgressReport {
  bookId: string;
  revisionId: string;
  generation: number;
  sequence: number;
  location: ReaderLocation;
  sizing: ReaderSizing;
}

/** Application bridge for trusted UI. Main validates every sender and value. */
export interface BorgesApi {
  library: {
    /** All Books, for the diagnostic list (the library UI is milestone 3). */
    books(): Promise<BookSummary[]>;
    openBook(bookId: string): Promise<void>;
  };
  reader: {
    /** Start this window's session for its assigned catalog book. */
    openBook(): Promise<OpenedBook>;
    /** Queue a position; the outcome arrives through `onProgressResult`. */
    reportProgress(report: ProgressReport): void;
    /** The engine rendered the book (status Unread → Currently Reading). */
    bookOpened(bookId: string, generation: number): Promise<void>;
    onProgressResult(listener: (result: ProgressResult) => void): () => void;
  };
}
