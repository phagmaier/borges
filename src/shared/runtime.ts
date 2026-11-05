import type {
  RestoredImportInfo,
  TrashChoice,
  TrashMatchPrompt,
} from "../library/trash-matches";

export type {
  TrashCandidate,
  TrashChoice,
  TrashMatchPrompt,
} from "../library/trash-matches";

import type { RestoredBook, TrashListing } from "../library/trash";

export type { RestoredBook, TrashEntry, TrashListing } from "../library/trash";

import type { DuplicateChoice, DuplicatePrompt } from "../library/duplicates";

export type { DuplicateChoice, DuplicatePrompt } from "../library/duplicates";

import type { MetadataEdit } from "../library/books";
import type { ImportProgress, ImportSummary } from "../library/import-batch";
import type { StoredSizing } from "../library/progress";
import type {
  BookQuery,
  BookSummary,
  FilterTerm,
  SectionNode,
} from "../library/query";
import type { LibraryErrorCode } from "../library/rules";
import type { SectionDeletion } from "../library/sections";
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

export type { MetadataEdit } from "../library/books";
export type {
  ImportOutcome,
  ImportOutcomeKind,
  ImportProgress,
  ImportSummary,
} from "../library/import-batch";
export type {
  BookQuery,
  BookSummary,
  FilterTerm,
  LibraryView,
  SectionNode,
} from "../library/query";
export type { SectionDeletion } from "../library/sections";

/**
 * Outcome of a library request. Service errors keep their code (Electron's
 * invoke would reduce a thrown error to text); `failed` is anything else.
 */
export type LibraryResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LibraryErrorCode | "failed"; message: string };
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
  /** Library-window requests; main refuses every other sender. */
  library: {
    /** Unresolved recovery diagnostics from this startup, library window only. */
    restoreRevision(
      entryId: string,
      mode: "current" | "separate",
      expectedCurrentId?: string,
    ): Promise<LibraryResult<RestoredImportInfo>>;
    resolveTrashMatch(
      token: string,
      choice: TrashChoice,
    ): Promise<LibraryResult<null>>;
    onImportTrashMatch(
      listener: (prompt: TrashMatchPrompt & { token: string }) => void,
    ): () => void;
    trash(): Promise<LibraryResult<TrashListing>>;
    deleteBook(bookId: string): Promise<LibraryResult<{ id: string }>>;
    restoreDeletedBook(entryId: string): Promise<LibraryResult<RestoredBook>>;
    startupProblems(): Promise<LibraryResult<string[]>>;
    /** Books matching a query, All Books by default. */
    books(query?: BookQuery): Promise<LibraryResult<BookSummary[]>>;
    filterTerms(
      query: BookQuery,
    ): Promise<
      LibraryResult<{ authors: FilterTerm[]; subjects: FilterTerm[] }>
    >;
    sections(options?: {
      includeArchived?: boolean;
    }): Promise<LibraryResult<SectionNode[]>>;
    createSection(
      name: string,
      parentId: string | null,
    ): Promise<LibraryResult<{ id: string; name: string }>>;
    renameSection(
      sectionId: string,
      name: string,
    ): Promise<LibraryResult<{ id: string; name: string }>>;
    moveSection(
      sectionId: string,
      parentId: string | null,
    ): Promise<LibraryResult<null>>;
    previewSectionDeletion(
      sectionId: string,
    ): Promise<LibraryResult<SectionDeletion>>;
    deleteSection(sectionId: string): Promise<LibraryResult<SectionDeletion>>;
    addToSection(
      sectionId: string,
      bookIds: string[],
    ): Promise<LibraryResult<{ added: number }>>;
    removeFromSection(
      sectionId: string,
      bookIds: string[],
    ): Promise<LibraryResult<{ removed: number }>>;
    finish(bookId: string): Promise<LibraryResult<BookSummary>>;
    archive(bookId: string): Promise<LibraryResult<BookSummary>>;
    unarchive(bookId: string): Promise<LibraryResult<BookSummary>>;
    /** Resets the position; an open reader is flushed and restarted. */
    startRereading(bookId: string): Promise<LibraryResult<BookSummary>>;
    editMetadata(
      bookId: string,
      edit: MetadataEdit,
    ): Promise<LibraryResult<BookSummary>>;
    /** Open main's local image chooser. Null means cancelled. */
    chooseCover(bookId: string): Promise<LibraryResult<BookSummary | null>>;
    /** Choose validated replacement bytes; old revision/location stay in Trash. */
    replaceFile(
      bookId: string,
    ): Promise<LibraryResult<{ book: BookSummary; warnings: string[] } | null>>;
    /** Only the current approved cover, requested lazily by visible cards. */
    cover(
      bookId: string,
      token: string,
    ): Promise<LibraryResult<Uint8Array | null>>;
    /**
     * Open main's file or folder chooser and import the selection, joining
     * `sectionId` when given (else Unfiled). Null means the chooser was
     * cancelled. Resolves when the whole batch has finished or was cancelled.
     */
    importBooks(
      kind: "files" | "folders",
      sectionId: string | null,
    ): Promise<LibraryResult<ImportSummary | null>>;
    /** Cancel the running import; false if none was running. */
    resolveDuplicate(
      token: string,
      choice: DuplicateChoice,
    ): Promise<LibraryResult<null>>;
    onImportDuplicate(
      listener: (prompt: DuplicatePrompt & { token: string }) => void,
    ): () => void;
    cancelImport(): Promise<LibraryResult<boolean>>;
    onImportProgress(listener: (progress: ImportProgress) => void): () => void;
    /** Open or focus the book's reader window. */
    openBook(bookId: string): Promise<LibraryResult<null>>;
    /** Called after any catalog change, including a reader's open. */
    onChanged(listener: () => void): () => void;
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
