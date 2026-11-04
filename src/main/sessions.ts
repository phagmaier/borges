import type { DatabaseSync } from "node:sqlite";
import { recordSuccessfulOpen } from "../library/books.ts";
import {
  beginReaderSession,
  endReaderSession,
  ProgressError,
  type ProgressErrorCode,
  type ProgressWrite,
  parseProgressWrite,
  type ReaderSessionGrant,
  saveProgress,
} from "../library/progress.ts";
import type { BookSummary } from "../library/query.ts";

// Central owner of reader progress. Each reader window (its webContents ID)
// holds at most one session for the book assigned to it. Messages are bound
// to that owner before storage sees them, then coalesced so rapid page turns
// cost one commit per interval. Pending positions are flushed when a session
// ends: window close, reload, Quit, and later replacement/deletion/reread.

export type SessionErrorCode = ProgressErrorCode | "not-assigned";

export type ProgressResult =
  | {
      ok: true;
      bookId: string;
      revisionId: string;
      generation: number;
      sequence: number;
      savedAt: number;
    }
  | {
      ok: false;
      bookId: string | null;
      generation: number | null;
      sequence: number | null;
      code: SessionErrorCode;
      message: string;
    };

export interface ReaderSessionsOptions {
  /** Longest a reported position waits before its commit. */
  delayMs?: number;
  now?: () => number;
}

interface OwnedSession {
  bookId: string;
  revisionId: string;
  generation: number;
  /** Highest sequence accepted for commit in this session. */
  accepted: number;
  /** Highest sequence committed in this session. */
  committed: number;
  pending?: ProgressWrite;
  timer?: ReturnType<typeof setTimeout>;
}

export class ReaderSessions {
  private readonly sessions = new Map<number, OwnedSession>();
  private readonly delayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly database: DatabaseSync,
    private readonly notify: (owner: number, result: ProgressResult) => void,
    options: ReaderSessionsOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  /**
   * Start the owner's session for its assigned book, first flushing and
   * retiring any earlier session of that owner (a reload).
   */
  begin(owner: number, bookId: string): ReaderSessionGrant {
    this.end(owner);
    const grant = beginReaderSession(this.database, bookId);
    this.sessions.set(owner, {
      bookId,
      revisionId: grant.revisionId,
      generation: grant.generation,
      accepted: 0,
      committed: 0,
    });
    return grant;
  }

  /** Queue an untrusted position from `owner`; the result is notified. */
  report(owner: number, input: unknown): void {
    let write: ProgressWrite;
    try {
      write = parseProgressWrite(input);
    } catch (error) {
      this.notify(owner, failure(error, input));
      return;
    }
    const session = this.sessions.get(owner);
    if (!session || session.bookId !== write.bookId) {
      this.notify(
        owner,
        rejected(
          "not-assigned",
          "This window has no reader session for that book.",
          write,
        ),
      );
      return;
    }
    if (session.generation !== write.generation) {
      this.notify(
        owner,
        rejected(
          "stale-session",
          "This reader session has ended; its position was not saved.",
          write,
        ),
      );
      return;
    }
    if (write.sequence <= session.accepted) {
      this.notify(
        owner,
        rejected(
          "out-of-order",
          `Position ${write.sequence} arrived after position ${session.accepted}.`,
          write,
        ),
      );
      return;
    }
    session.accepted = write.sequence;
    session.pending = write;
    session.timer ??= setTimeout(() => this.commit(owner), this.delayMs);
  }

  /**
   * Record that the owner's reader rendered its book, so an unread,
   * unarchived book starts reading. Failed loads never call this.
   */
  opened(owner: number, bookId: unknown, generation: unknown): BookSummary {
    const session = this.sessions.get(owner);
    if (
      !session ||
      session.bookId !== bookId ||
      session.generation !== generation
    )
      throw new ProgressError(
        "stale-session",
        "This reader session is not the current one for its book.",
      );
    return recordSuccessfulOpen(this.database, session.bookId, this.now());
  }

  /** The owner's current session, if any. */
  sessionOf(owner: number): { bookId: string; generation: number } | null {
    const session = this.sessions.get(owner);
    return session
      ? { bookId: session.bookId, generation: session.generation }
      : null;
  }

  /** Commit the owner's pending position now. */
  flush(owner: number): void {
    this.commit(owner);
  }

  /**
   * Flush, then retire the owner's session so no later message from it can
   * write. Never throws: closing a window must not be blocked by storage.
   */
  end(owner: number): void {
    const session = this.sessions.get(owner);
    if (!session) return;
    this.commit(owner);
    this.sessions.delete(owner);
    try {
      endReaderSession(this.database, session.bookId, session.generation);
    } catch (error) {
      // The next grant advances the generation anyway.
      console.error(
        `Could not retire the reader session for ${session.bookId}: ${message(error)}`,
      );
    }
  }

  /** Flush and retire every session (Quit). */
  endAll(): void {
    for (const owner of [...this.sessions.keys()]) this.end(owner);
  }

  private commit(owner: number): void {
    const session = this.sessions.get(owner);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
    const write = session.pending;
    if (!write) return;
    session.pending = undefined;
    try {
      const ack = saveProgress(this.database, write, this.now());
      session.committed = write.sequence;
      this.notify(owner, { ok: true, ...ack });
    } catch (error) {
      // Keep a storage failure for retry at the next report or flush; any
      // other rejection is final for that write.
      if (error instanceof ProgressError && error.code === "storage-failed")
        session.pending ??= write;
      // A rejected write never landed, so it does not raise the floor.
      else session.accepted = session.committed;
      this.notify(owner, failure(error, write));
    }
  }
}

function failure(error: unknown, input: unknown): ProgressResult {
  return rejected(
    error instanceof ProgressError ? error.code : "storage-failed",
    message(error),
    input,
  );
}

function rejected(
  code: SessionErrorCode,
  text: string,
  input: unknown,
): ProgressResult {
  const value = (input ?? {}) as Record<string, unknown>;
  const pick = <T>(key: string, check: (v: unknown) => boolean) =>
    check(value[key]) ? (value[key] as T) : null;
  return {
    ok: false,
    bookId: pick<string>("bookId", (v) => typeof v === "string"),
    generation: pick<number>("generation", Number.isSafeInteger),
    sequence: pick<number>("sequence", Number.isSafeInteger),
    code,
    message: text,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
