import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginReaderSession } from "../../src/library/progress";
import { getBook } from "../../src/library/query";
import { type ProgressResult, ReaderSessions } from "../../src/main/sessions";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { addBook } from "./library-fixtures";

let temporary: string;
let library: Library;
let database: DatabaseSync;
let results: { owner: number; result: ProgressResult }[];
let sessions: ReaderSessions;

const A = 1; // webContents IDs of two reader windows and the library.
const B = 2;
const LIBRARY = 3;

beforeEach(() => {
  vi.useFakeTimers();
  temporary = mkdtempSync(join(tmpdir(), "borges-sessions-"));
  library = openLibrary({ root: join(temporary, "library") });
  database = library.database;
  addBook(database, { book: "a", revision: "a-1", title: "Atlas" });
  addBook(database, { book: "b", revision: "b-1", title: "Bestiary" });
  results = [];
  sessions = new ReaderSessions(
    database,
    (owner, result) => results.push({ owner, result }),
    { delayMs: 250, now: () => 5000 },
  );
});
afterEach(() => {
  vi.useRealTimers();
  library.close();
  rmSync(temporary, { recursive: true, force: true });
});

const sizing = { fontSize: 18, zoom: 1 };
function report(
  grant: { bookId: string; revisionId: string; generation: number },
  sequence: number,
  page: number,
) {
  return {
    bookId: grant.bookId,
    revisionId: grant.revisionId,
    generation: grant.generation,
    sequence,
    location: { format: "pdf", page, x: 0, y: 0 },
    sizing,
  };
}
const storedPage = (revision: string) =>
  database
    .prepare("SELECT pdf_page, sequence FROM positions WHERE revision_id = ?")
    .get(revision) ?? null;
const codes = () =>
  results.map(({ owner, result }) => [owner, result.ok ? "ok" : result.code]);

describe("coalescing", () => {
  it("keeps the reader assigned if durable session retirement fails", () => {
    const grant = sessions.begin(A, "a");
    database.exec(`CREATE TEMP TRIGGER fail_retirement BEFORE UPDATE OF session_generation ON books
      BEGIN SELECT RAISE(ABORT, 'catalog full'); END`);
    expect(() => sessions.quiesce(A)).toThrow(/catalog full/);
    expect(sessions.sessionOf(A)).toEqual({
      bookId: "a",
      generation: grant.generation,
    });
    database.exec("DROP TRIGGER fail_retirement");
    sessions.quiesce(A);
    expect(sessions.sessionOf(A)).toBeNull();
  });

  it("refuses replacement when flushing fails, retains the session for retry, then retires it", () => {
    const grant = sessions.begin(A, "a");
    sessions.report(A, report(grant, 1, 3));
    database.exec(`CREATE TEMP TRIGGER fail_positions BEFORE INSERT ON positions
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    expect(() => sessions.quiesce(A)).toThrow(/could not be saved/);
    expect(sessions.sessionOf(A)).toEqual({
      bookId: "a",
      generation: grant.generation,
    });
    expect(storedPage("a-1")).toBeNull();
    database.exec("DROP TRIGGER fail_positions");
    sessions.quiesce(A);
    expect(storedPage("a-1")).toEqual({ pdf_page: 3, sequence: 1 });
    expect(sessions.sessionOf(A)).toBeNull();
    sessions.report(A, report(grant, 2, 10));
    expect(storedPage("a-1")).toEqual({ pdf_page: 3, sequence: 1 });
    expect(codes()).toEqual([
      [A, "storage-failed"],
      [A, "ok"],
      [A, "not-assigned"],
    ]);
  });

  it("commits only the latest position per interval and acknowledges it", () => {
    const grant = sessions.begin(A, "a");
    for (const [sequence, page] of [
      [1, 2],
      [2, 3],
      [3, 5],
    ] as const)
      sessions.report(A, report(grant, sequence, page));
    expect(storedPage("a-1")).toBeNull();
    vi.advanceTimersByTime(249);
    expect(storedPage("a-1")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(storedPage("a-1")).toEqual({ pdf_page: 5, sequence: 3 });
    expect(results).toEqual([
      {
        owner: A,
        result: {
          ok: true,
          bookId: "a",
          revisionId: "a-1",
          generation: grant.generation,
          sequence: 3,
          savedAt: 5000,
        },
      },
    ]);
    // A later turn starts a new interval.
    sessions.report(A, report(grant, 4, 6));
    vi.advanceTimersByTime(250);
    expect(storedPage("a-1")).toEqual({ pdf_page: 6, sequence: 4 });
  });

  it("flushes the pending position when the window closes and then rejects it", () => {
    const grant = sessions.begin(A, "a");
    sessions.report(A, report(grant, 1, 9));
    sessions.end(A);
    expect(storedPage("a-1")).toEqual({ pdf_page: 9, sequence: 1 });
    sessions.report(A, report(grant, 2, 10));
    vi.runAllTimers();
    expect(storedPage("a-1")).toEqual({ pdf_page: 9, sequence: 1 });
    expect(codes()).toEqual([
      [A, "ok"],
      [A, "not-assigned"],
    ]);
    // The retired generation is also rejected by storage itself.
    expect(beginReaderSession(database, "a").generation).toBe(
      grant.generation + 2,
    );
  });

  it("a reload flushes the old page's position and retires its session", () => {
    const old = sessions.begin(A, "a");
    sessions.report(A, report(old, 1, 4));
    const fresh = sessions.begin(A, "a");
    expect(fresh.generation).toBeGreaterThan(old.generation);
    expect(fresh.location).toMatchObject({ page: 4 });
    sessions.report(A, report(old, 2, 8)); // Late message from the old page.
    sessions.report(A, report(fresh, 1, 6));
    vi.runAllTimers();
    expect(storedPage("a-1")).toEqual({ pdf_page: 6, sequence: 1 });
    expect(codes()).toEqual([
      [A, "ok"],
      [A, "stale-session"],
      [A, "ok"],
    ]);
  });

  it("Quit flushes every open reader", () => {
    const a = sessions.begin(A, "a");
    const b = sessions.begin(B, "b");
    sessions.report(A, report(a, 1, 2));
    sessions.report(B, report(b, 1, 3));
    sessions.endAll();
    expect(storedPage("a-1")).toMatchObject({ pdf_page: 2 });
    expect(storedPage("b-1")).toMatchObject({ pdf_page: 3 });
    expect(sessions.sessionOf(A)).toBeNull();
    expect(sessions.sessionOf(B)).toBeNull();
  });
});

describe("sender binding", () => {
  it("rejects positions for another window's book or from a window without a session", () => {
    const a = sessions.begin(A, "a");
    const b = sessions.begin(B, "b");
    sessions.report(A, report(b, 1, 7)); // Window A forging book B.
    sessions.report(LIBRARY, report(a, 1, 7));
    sessions.report(A, { ...report(a, 1, 7), generation: a.generation + 1 });
    sessions.report(A, { ...report(a, 1, 7), location: { format: "pdf" } });
    vi.runAllTimers();
    expect(storedPage("a-1")).toBeNull();
    expect(storedPage("b-1")).toBeNull();
    expect(codes()).toEqual([
      [A, "not-assigned"],
      [LIBRARY, "not-assigned"],
      [A, "stale-session"],
      [A, "invalid"],
    ]);
    expect(results[0]?.result).toMatchObject({ bookId: "b", sequence: 1 });
  });

  it("rejects replayed and reordered sequences, including against the pending one", () => {
    const grant = sessions.begin(A, "a");
    sessions.report(A, report(grant, 2, 5));
    sessions.report(A, report(grant, 1, 4)); // Older than the pending write.
    vi.runAllTimers();
    sessions.report(A, report(grant, 2, 3)); // Replay of a committed write.
    vi.runAllTimers();
    expect(storedPage("a-1")).toEqual({ pdf_page: 5, sequence: 2 });
    expect(codes()).toEqual([
      [A, "out-of-order"],
      [A, "ok"],
      [A, "out-of-order"],
    ]);
  });

  it("passes storage rejections through without raising the sequence floor", () => {
    const grant = sessions.begin(A, "a");
    sessions.report(A, { ...report(grant, 5, 2), revisionId: "b-1" });
    vi.runAllTimers();
    expect(codes()).toEqual([[A, "stale-revision"]]);
    expect(storedPage("b-1")).toBeNull();
    // A rejected write never landed, so a lower sequence is still accepted.
    sessions.report(A, report(grant, 2, 4));
    vi.runAllTimers();
    expect(storedPage("a-1")).toEqual({ pdf_page: 4, sequence: 2 });
  });

  it("retains a write whose commit failed and retries it at the next flush", () => {
    const grant = sessions.begin(A, "a");
    database.exec(`CREATE TEMP TRIGGER fail_positions BEFORE INSERT ON positions
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    sessions.report(A, report(grant, 1, 11));
    vi.runAllTimers();
    expect(codes()).toEqual([[A, "storage-failed"]]);
    database.exec("DROP TRIGGER fail_positions");
    sessions.end(A);
    expect(storedPage("a-1")).toEqual({ pdf_page: 11, sequence: 1 });
    expect(codes()).toEqual([
      [A, "storage-failed"],
      [A, "ok"],
    ]);
  });
});

describe("successful open", () => {
  it("starts reading only for the window's current session", () => {
    const grant = sessions.begin(A, "a");
    expect(() => sessions.opened(A, "b", grant.generation)).toThrow();
    expect(() => sessions.opened(B, "a", grant.generation)).toThrow();
    expect(() => sessions.opened(A, "a", grant.generation - 1)).toThrow();
    expect(getBook(database, "a").status).toBe("unread");
    expect(sessions.opened(A, "a", grant.generation)).toMatchObject({
      status: "reading",
      lastOpenedAt: 5000,
    });
  });
});
