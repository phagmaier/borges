import type { DatabaseSync } from "node:sqlite";
import type { ReaderLocation, ReaderSizing } from "../readers/session.ts";
import { immediate } from "../storage/transaction.ts";

// Reader progress storage. Every check that decides whether a write may land
// (current revision, live session generation, sequence order) runs inside the
// same transaction as the write, against committed catalog state. The window
// coordinator must additionally bind each message to the sender assigned to
// that book before calling `saveProgress`.

export type ProgressErrorCode =
  | "invalid"
  | "unknown-book"
  | "stale-revision"
  | "stale-session"
  | "out-of-order"
  | "storage-failed";

export class ProgressError extends Error {
  readonly code: ProgressErrorCode;
  constructor(code: ProgressErrorCode, message: string) {
    super(message);
    this.name = "ProgressError";
    this.code = code;
  }
}

export interface StoredSizing {
  fontSize: number | null;
  zoom: number | null;
}

/** What a newly opened reader may restore and the session it must write as. */
export interface ReaderSessionGrant {
  bookId: string;
  revisionId: string;
  format: "pdf" | "epub";
  generation: number;
  /** Last committed position of the current revision, if any. */
  location: ReaderLocation | null;
  sizing: StoredSizing;
}

export interface ProgressWrite {
  bookId: string;
  revisionId: string;
  generation: number;
  /** Strictly increasing within one session generation, starting at 1. */
  sequence: number;
  location: ReaderLocation;
  sizing: ReaderSizing;
}

/** Sent only after the write has committed. */
export interface ProgressAck {
  bookId: string;
  revisionId: string;
  generation: number;
  sequence: number;
  savedAt: number;
}

interface BookRow {
  revision: string;
  generation: number;
  format: "pdf" | "epub";
}

function liveBook(database: DatabaseSync, bookId: string): BookRow {
  const row = database
    .prepare(
      `SELECT b.current_revision_id AS revision, b.session_generation AS generation,
         r.format AS format
       FROM books b JOIN revisions r ON r.id = b.current_revision_id
       WHERE b.id = ? AND b.deleted_at IS NULL`,
    )
    .get(bookId);
  if (!row)
    throw new ProgressError("unknown-book", "This book is not in the library.");
  return row as unknown as BookRow;
}

/**
 * Start the only session allowed to write this book's progress. Any earlier
 * session (a previous window, a reload) is retired by the same commit.
 */
export function beginReaderSession(
  database: DatabaseSync,
  bookId: string,
): ReaderSessionGrant {
  return storage(() =>
    immediate(database, () => {
      const book = liveBook(database, bookId);
      const generation = book.generation + 1;
      database
        .prepare("UPDATE books SET session_generation = ? WHERE id = ?")
        .run(generation, bookId);
      const position = database
        .prepare("SELECT * FROM positions WHERE revision_id = ?")
        .get(book.revision);
      const settings = database
        .prepare(
          "SELECT font_size, zoom FROM reader_settings WHERE book_id = ?",
        )
        .get(bookId);
      return {
        bookId,
        revisionId: book.revision,
        format: book.format,
        generation,
        location: position ? toLocation(position) : null,
        sizing: {
          fontSize: (settings?.font_size as number | null) ?? null,
          zoom: (settings?.zoom as number | null) ?? null,
        },
      };
    }),
  );
}

/**
 * Retire a session after its final flush (close, Quit) or before replacement,
 * deletion or reread. Returns false if that generation was already retired.
 */
export function endReaderSession(
  database: DatabaseSync,
  bookId: string,
  generation: number,
): boolean {
  return storage(
    () =>
      database
        .prepare(
          "UPDATE books SET session_generation = session_generation + 1 WHERE id = ? AND session_generation = ?",
        )
        .run(bookId, generation).changes > 0,
  );
}

/** Validate an untrusted progress message and commit it, or explain why not. */
export function saveProgress(
  database: DatabaseSync,
  input: unknown,
  now: number = Date.now(),
): ProgressAck {
  const write = parseProgressWrite(input);
  return storage(() =>
    immediate(database, () => {
      const book = liveBook(database, write.bookId);
      if (book.revision !== write.revisionId) {
        throw new ProgressError(
          "stale-revision",
          "This position belongs to a file revision that is no longer current.",
        );
      }
      if (book.generation !== write.generation) {
        throw new ProgressError(
          "stale-session",
          "This reader session has ended; its position was not saved.",
        );
      }
      if (book.format !== write.location.format) {
        throw new ProgressError(
          "invalid",
          `A ${write.location.format} location cannot be saved for a ${book.format} file.`,
        );
      }
      const previous = database
        .prepare(
          "SELECT generation, sequence FROM positions WHERE revision_id = ?",
        )
        .get(write.revisionId);
      if (
        previous?.generation === write.generation &&
        Number(previous.sequence) >= write.sequence
      ) {
        throw new ProgressError(
          "out-of-order",
          `Position ${write.sequence} arrived after position ${previous.sequence}.`,
        );
      }
      const { location: l, sizing } = write;
      database
        .prepare(
          `INSERT OR REPLACE INTO positions (revision_id, format, pdf_page,
             epub_cfi, epub_section, epub_fraction, pan_x, pan_y, sequence,
             updated_at, generation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          write.revisionId,
          l.format,
          l.format === "pdf" ? l.page : null,
          l.format === "epub" ? l.cfi : null,
          l.format === "epub" ? l.section : null,
          l.format === "epub" ? l.fraction : null,
          l.x,
          l.y,
          write.sequence,
          now,
          write.generation,
        );
      database
        .prepare(
          "INSERT OR REPLACE INTO reader_settings (book_id, font_size, zoom, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(write.bookId, sizing.fontSize, sizing.zoom, now);
      return {
        bookId: write.bookId,
        revisionId: write.revisionId,
        generation: write.generation,
        sequence: write.sequence,
        savedAt: now,
      };
    }),
  );
}

/** Report SQLite/filesystem failures distinctly; nothing was committed. */
function storage<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ProgressError) throw error;
    throw new ProgressError(
      "storage-failed",
      `The position could not be saved (${error instanceof Error ? error.message : String(error)}). The last saved position is unchanged.`,
    );
  }
}

function toLocation(row: Record<string, unknown>): ReaderLocation {
  const x = Number(row.pan_x);
  const y = Number(row.pan_y);
  return row.format === "pdf"
    ? { format: "pdf", page: Number(row.pdf_page), x, y }
    : {
        format: "epub",
        cfi: String(row.epub_cfi),
        section: Number(row.epub_section),
        fraction: Number(row.epub_fraction),
        x,
        y,
      };
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 64;
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;
const isUnit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const inRange = (value: unknown, low: number, high: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= low &&
  value <= high;

/** Rebuild a write from untrusted input, keeping only known fields. */
export function parseProgressWrite(input: unknown): ProgressWrite {
  const value = (input ?? {}) as Record<string, unknown>;
  const location = (value.location ?? {}) as Record<string, unknown>;
  const sizing = (value.sizing ?? {}) as Record<string, unknown>;
  const invalid = (reason: string) =>
    new ProgressError("invalid", `Invalid progress message: ${reason}.`);
  if (!isId(value.bookId) || !isId(value.revisionId))
    throw invalid("book and revision IDs are required");
  if (!isCount(value.generation) || !isCount(value.sequence))
    throw invalid("generation and sequence must be positive integers");
  if (!isUnit(location.x) || !isUnit(location.y))
    throw invalid("pan must be within the page");
  if (!inRange(sizing.fontSize, 8, 72) || !inRange(sizing.zoom, 0.25, 8))
    throw invalid("sizing is out of range");
  let parsed: ReaderLocation;
  if (location.format === "pdf") {
    if (!isCount(location.page)) throw invalid("PDF page must be 1 or more");
    parsed = {
      format: "pdf",
      page: location.page,
      x: location.x,
      y: location.y,
    };
  } else if (location.format === "epub") {
    if (
      typeof location.cfi !== "string" ||
      location.cfi.length < 1 ||
      location.cfi.length > 16384 ||
      !Number.isSafeInteger(location.section) ||
      (location.section as number) < 0 ||
      !isUnit(location.fraction)
    )
      throw invalid("EPUB locator is malformed");
    parsed = {
      format: "epub",
      cfi: location.cfi,
      section: location.section as number,
      fraction: location.fraction,
      x: location.x,
      y: location.y,
    };
  } else {
    throw invalid("unknown location format");
  }
  return {
    bookId: value.bookId,
    revisionId: value.revisionId,
    generation: value.generation,
    sequence: value.sequence,
    location: parsed,
    sizing: {
      fontSize: sizing.fontSize as number,
      zoom: sizing.zoom as number,
    },
  };
}
