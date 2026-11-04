import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginReaderSession,
  endReaderSession,
  ProgressError,
  saveProgress,
} from "../../src/library/progress";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { catalogMigrations } from "../../src/storage/schema";
import {
  addBook,
  addRevision,
  kill,
  killChildren,
  startChild,
} from "./library-fixtures";

let temporary: string;
let root: string;
let library: Library | undefined;
let database: DatabaseSync;

function reopen() {
  library?.close();
  library = openLibrary({ root });
  database = library.database;
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "borges-progress-"));
  root = join(temporary, "library");
  reopen();
  addBook(database, { book: "pdf", revision: "pdf-1", title: "Atlas" });
  addBook(database, {
    book: "epub",
    revision: "epub-1",
    title: "Labyrinths",
    format: "epub",
  });
});
afterEach(() => {
  killChildren();
  library?.close();
  library = undefined;
  rmSync(temporary, { recursive: true, force: true });
});

const sizing = { fontSize: 18, zoom: 1.25 };
const page = (n: number) => ({ format: "pdf" as const, page: n, x: 0.5, y: 0 });
function write(
  grant: { bookId: string; revisionId: string; generation: number },
  sequence: number,
  location: object = page(sequence),
) {
  return {
    bookId: grant.bookId,
    revisionId: grant.revisionId,
    generation: grant.generation,
    sequence,
    location,
    sizing,
  };
}

function rejection(action: () => unknown): ProgressError {
  try {
    action();
  } catch (error) {
    if (error instanceof ProgressError) return error;
    throw error;
  }
  throw new Error("expected a ProgressError");
}

const storedPage = (revision = "pdf-1") =>
  database
    .prepare("SELECT pdf_page FROM positions WHERE revision_id = ?")
    .get(revision)?.pdf_page ?? null;

describe("reader session grants and restoration", () => {
  it("restores the last committed position and sizing in a later process", () => {
    const first = beginReaderSession(database, "pdf");
    expect(first).toEqual({
      bookId: "pdf",
      revisionId: "pdf-1",
      format: "pdf",
      generation: 1,
      location: null,
      sizing: { fontSize: null, zoom: null },
    });
    expect(saveProgress(database, write(first, 1), 1000)).toEqual({
      bookId: "pdf",
      revisionId: "pdf-1",
      generation: 1,
      sequence: 1,
      savedAt: 1000,
    });
    saveProgress(database, write(first, 2, { ...page(42), x: 0.25, y: 1 }));
    reopen();
    expect(beginReaderSession(database, "pdf")).toMatchObject({
      generation: 2,
      location: { format: "pdf", page: 42, x: 0.25, y: 1 },
      sizing,
    });
  });

  it("round-trips an EPUB locator with its chapter and fraction context", () => {
    const grant = beginReaderSession(database, "epub");
    const location = {
      format: "epub",
      cfi: "epubcfi(/6/8!/4/2/10,/1:0,/1:24)",
      section: 3,
      fraction: 0.4375,
      x: 0,
      y: 0,
    };
    saveProgress(database, write(grant, 1, location));
    reopen();
    expect(beginReaderSession(database, "epub").location).toEqual(location);
  });

  it("does not grant sessions for unknown or deleted books", () => {
    expect(rejection(() => beginReaderSession(database, "nope")).code).toBe(
      "unknown-book",
    );
    database.exec("UPDATE books SET deleted_at = 5 WHERE id = 'pdf'");
    expect(rejection(() => beginReaderSession(database, "pdf")).code).toBe(
      "unknown-book",
    );
  });
});

describe("stale and reordered writes are rejected against committed state", () => {
  it("retires an earlier session when the book is opened again", () => {
    const old = beginReaderSession(database, "pdf");
    saveProgress(database, write(old, 1, page(5)));
    const reloaded = beginReaderSession(database, "pdf");
    expect(reloaded.generation).toBe(old.generation + 1);
    // A late write from the old window must not overwrite the new session.
    expect(
      rejection(() => saveProgress(database, write(old, 2, page(99)))).code,
    ).toBe("stale-session");
    expect(storedPage()).toBe(5);
    // The new generation starts its own sequence below the stored one.
    saveProgress(database, write(reloaded, 1, page(7)));
    expect(storedPage()).toBe(7);
  });

  it("rejects writes after a session is ended, once", () => {
    const grant = beginReaderSession(database, "pdf");
    saveProgress(database, write(grant, 1, page(3)));
    expect(endReaderSession(database, "pdf", grant.generation)).toBe(true);
    expect(endReaderSession(database, "pdf", grant.generation)).toBe(false);
    expect(
      rejection(() => saveProgress(database, write(grant, 2, page(4)))).code,
    ).toBe("stale-session");
    expect(storedPage()).toBe(3);
  });

  it("rejects replays and reordered sequences within a session", () => {
    const grant = beginReaderSession(database, "pdf");
    saveProgress(database, write(grant, 1, page(1)));
    saveProgress(database, write(grant, 3, page(3)));
    for (const sequence of [3, 2])
      expect(
        rejection(() => saveProgress(database, write(grant, sequence, page(9))))
          .code,
      ).toBe("out-of-order");
    expect(storedPage()).toBe(3);
  });

  it("rejects the old revision's session after a replacement-style switch", () => {
    const grant = beginReaderSession(database, "pdf");
    saveProgress(database, write(grant, 1, page(12)));
    // The contract replacement must follow: switch revision and advance the
    // generation in one commit.
    database.exec("BEGIN");
    addRevision(database, { book: "pdf", revision: "pdf-2", format: "epub" });
    database.exec(
      "UPDATE books SET current_revision_id = 'pdf-2', session_generation = session_generation + 1 WHERE id = 'pdf'",
    );
    database.exec("COMMIT");
    expect(
      rejection(() => saveProgress(database, write(grant, 2, page(13)))).code,
    ).toBe("stale-revision");
    // Even naming the new revision, the old generation cannot write.
    expect(
      rejection(() =>
        saveProgress(database, {
          ...write(grant, 2),
          revisionId: "pdf-2",
          location: {
            format: "epub",
            cfi: "x",
            section: 0,
            fraction: 0,
            x: 0,
            y: 0,
          },
        }),
      ).code,
    ).toBe("stale-session");
    // The retired revision keeps its own position for Trash/reference.
    expect(storedPage("pdf-1")).toBe(12);
    const next = beginReaderSession(database, "pdf");
    expect(next).toMatchObject({
      revisionId: "pdf-2",
      format: "epub",
      location: null,
    });
  });

  it("rejects a write naming another book's revision", () => {
    const grant = beginReaderSession(database, "pdf");
    beginReaderSession(database, "epub");
    expect(
      rejection(() =>
        saveProgress(database, { ...write(grant, 1), revisionId: "epub-1" }),
      ).code,
    ).toBe("stale-revision");
  });
});

describe("untrusted progress messages", () => {
  const valid = () => write(beginReaderSession(database, "pdf"), 1);
  it.each([
    ["no message", () => undefined],
    ["a missing book ID", () => ({ ...valid(), bookId: undefined })],
    ["a numeric revision", () => ({ ...valid(), revisionId: 7 })],
    ["sequence 0", () => ({ ...valid(), sequence: 0 })],
    ["a fractional sequence", () => ({ ...valid(), sequence: 1.5 })],
    ["a string generation", () => ({ ...valid(), generation: "1" })],
    ["page 0", () => ({ ...valid(), location: page(0) })],
    [
      "a NaN pan",
      () => ({ ...valid(), location: { ...page(1), x: Number.NaN } }),
    ],
    [
      "pan beyond the page",
      () => ({ ...valid(), location: { ...page(1), y: 1.01 } }),
    ],
    [
      "an unknown format",
      () => ({ ...valid(), location: { format: "djvu", x: 0, y: 0 } }),
    ],
    [
      "an EPUB fraction above 1",
      () => ({
        ...valid(),
        location: {
          format: "epub",
          cfi: "c",
          section: 0,
          fraction: 1.5,
          x: 0,
          y: 0,
        },
      }),
    ],
    [
      "an oversized font",
      () => ({ ...valid(), sizing: { fontSize: 100, zoom: 1 } }),
    ],
    [
      "an EPUB locator for a PDF revision",
      () => ({
        ...valid(),
        location: {
          format: "epub",
          cfi: "c",
          section: 0,
          fraction: 0,
          x: 0,
          y: 0,
        },
      }),
    ],
  ])("rejects %s without writing", (_, message) => {
    expect(rejection(() => saveProgress(database, message())).code).toBe(
      "invalid",
    );
    expect(storedPage()).toBeNull();
  });

  it("reports an unknown book", () => {
    expect(
      rejection(() => saveProgress(database, { ...valid(), bookId: "ghost" }))
        .code,
    ).toBe("unknown-book");
  });
});

describe("storage failures and termination", () => {
  it("reports a failed write and keeps both position and sizing unchanged", () => {
    const grant = beginReaderSession(database, "pdf");
    saveProgress(database, write(grant, 1, page(8)));
    // Fail the second statement so a non-atomic save would leave a new page.
    database.exec(`CREATE TRIGGER fail_settings BEFORE INSERT ON reader_settings
      BEGIN SELECT RAISE(FAIL, 'injected disk failure'); END;`);
    const error = rejection(() =>
      saveProgress(database, {
        ...write(grant, 2, page(9)),
        sizing: { fontSize: 30, zoom: 3 },
      }),
    );
    expect(error.code).toBe("storage-failed");
    expect(error.message).toContain("injected disk failure");
    expect(storedPage()).toBe(8);
    expect(
      database.prepare("SELECT font_size, zoom FROM reader_settings").get(),
    ).toEqual({ font_size: 18, zoom: 1.25 });
    database.exec("DROP TRIGGER fail_settings");
    // The failed sequence was not consumed; the reader can retry it.
    saveProgress(database, write(grant, 2, page(9)));
    expect(storedPage()).toBe(9);
  });

  it("keeps acknowledged positions after the writing process is killed", async () => {
    addBook(database, { book: "b1", revision: "r1", title: "Child's book" });
    library?.close();
    library = undefined;
    const child = await startChild("save-then-hang", root, "acked 3");
    await kill(child);
    reopen();
    expect(beginReaderSession(database, "b1")).toMatchObject({
      location: { format: "pdf", page: 30, x: 0, y: 0.5 },
      sizing: { fontSize: 16, zoom: 1.5 },
    });
  });
});

describe("schema 2 upgrade", () => {
  it("adds session generations to a schema-1 catalog without losing positions", () => {
    library?.close();
    rmSync(root, { recursive: true });
    library = openLibrary({ root, migrations: catalogMigrations.slice(0, 1) });
    addBook(library.database, { book: "old", revision: "old-1", title: "Old" });
    library.database.exec(
      "INSERT INTO positions (revision_id, format, pdf_page, pan_x, pan_y, sequence, updated_at) VALUES ('old-1', 'pdf', 77, 0, 0, 40, 1)",
    );
    reopen();
    expect(library?.upgrade).toMatchObject({ from: 1, to: 2 });
    const grant = beginReaderSession(database, "old");
    expect(grant).toMatchObject({
      generation: 1,
      location: { format: "pdf", page: 77 },
    });
    // The migrated position's sequence belongs to no live generation.
    saveProgress(database, write(grant, 1, page(78)));
    expect(storedPage("old-1")).toBe(78);
  });
});
