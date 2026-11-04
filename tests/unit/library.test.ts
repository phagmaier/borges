import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveBook,
  editMetadata,
  markFinished,
  recordSuccessfulOpen,
  startRereading,
  unarchiveBook,
} from "../../src/library/books";
import {
  beginReaderSession,
  type ProgressError,
  saveProgress,
} from "../../src/library/progress";
import {
  getBook,
  type LibraryView,
  listFilterTerms,
  listSections,
  queryBooks,
  type SectionNode,
} from "../../src/library/query";
import { LibraryError } from "../../src/library/rules";
import {
  addBooksToSection,
  createSection,
  deleteSection,
  moveSection,
  previewSectionDeletion,
  removeBooksFromSection,
  renameSection,
} from "../../src/library/sections";
import { type Library, openLibrary } from "../../src/storage/catalog";
import { addBook } from "./library-fixtures";

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
  temporary = mkdtempSync(join(tmpdir(), "borges-library-"));
  root = join(temporary, "library");
  reopen();
});
afterEach(() => {
  library?.close();
  library = undefined;
  rmSync(temporary, { recursive: true, force: true });
});

function book(
  id: string,
  title: string,
  authors: string[] = [],
  subjects: string[] = [],
) {
  addBook(database, { book: id, revision: `${id}-r1`, title });
  if (authors.length || subjects.length)
    editMetadata(database, id, { authors, subjects });
}

// Deletion is a milestone-four feature; its catalog effect is the timestamp.
const softDelete = (id: string) =>
  database.prepare("UPDATE books SET deleted_at = 9 WHERE id = ?").run(id);

const ids = (query: object) =>
  queryBooks(database, query).map((entry) => entry.id);
const view = (kind: string, extra: object = {}) =>
  ({ view: { kind, ...extra } }) as { view: LibraryView };

function failure(action: () => unknown): LibraryError {
  try {
    action();
  } catch (error) {
    if (error instanceof LibraryError) return error;
    throw error;
  }
  throw new Error("expected a LibraryError");
}

function section(name: string, parentId?: string) {
  return createSection(database, { name, parentId }).id;
}

const counts = (nodes: SectionNode[]): Record<string, number> =>
  Object.fromEntries(
    nodes.flatMap((node) => [
      [node.name, node.bookCount],
      ...Object.entries(counts(node.children)),
    ]),
  );

describe("views and archive/Trash scope", () => {
  beforeEach(() => {
    book("live", "Live");
    book("archived", "Archived");
    book("deleted", "Deleted");
    book("archived-deleted", "Archived and deleted");
    archiveBook(database, "archived", 100);
    archiveBook(database, "archived-deleted", 100);
    softDelete("deleted");
    softDelete("archived-deleted");
  });

  it("hides archived books unless included, and deleted books always", () => {
    expect(ids(view("all"))).toEqual(["live"]);
    expect(ids({ ...view("all"), includeArchived: true })).toEqual([
      "archived",
      "live",
    ]);
    expect(ids(view("archive"))).toEqual(["archived"]);
    // The toggle cannot widen Archive into non-archived books.
    expect(ids({ ...view("archive"), includeArchived: true })).toEqual([
      "archived",
    ]);
    for (const text of ["deleted", "and"])
      expect(ids({ ...view("all"), text, includeArchived: true })).toEqual([]);
    expect(failure(() => getBook(database, "deleted")).code).toBe(
      "unknown-book",
    );
  });

  it("Unfiled lists books without memberships and applies the archive toggle", () => {
    book("filed", "Filed");
    const shelf = section("Shelf");
    addBooksToSection(database, shelf, ["filed"]);
    expect(ids(view("unfiled"))).toEqual(["live"]);
    expect(ids({ ...view("unfiled"), includeArchived: true })).toEqual([
      "archived",
      "live",
    ]);
  });

  it("Currently Reading sorts by last opened and Archive by last archived", () => {
    book("a", "Alpha");
    book("b", "Beta");
    book("c", "Gamma");
    for (const [id, at] of [
      ["b", 10],
      ["a", 30],
      ["c", 20],
    ] as const)
      recordSuccessfulOpen(database, id, at);
    expect(ids(view("reading"))).toEqual(["a", "c", "b"]);
    for (const [id, at] of [
      ["a", 300],
      ["b", 200],
    ] as const)
      archiveBook(database, id, at);
    expect(ids(view("archive"))).toEqual(["a", "b", "archived"]);
    expect(ids(view("reading"))).toEqual(["c"]);
    expect(ids({ ...view("reading"), includeArchived: true })).toEqual([
      "a",
      "c",
      "b",
    ]);
    markFinished(database, "c");
    expect(ids(view("finished"))).toEqual(["c"]);
    expect(ids(view("reading"))).toEqual([]);
  });

  it("sorts by title ignoring case and accents, numerically, then author, then ID", () => {
    book("x3", "book 10");
    book("x2", "Book 2");
    book("x1", "éclair");
    book("x4", "Eclair", ["Zola"]);
    book("x5", "eclair", ["Austen"]);
    book("x0", "Zebra");
    expect(ids(view("all"))).toEqual([
      "x2",
      "x3",
      "x5",
      "x4",
      "x1", // Same title; no author sorts after named authors.
      "live",
      "x0",
    ]);
  });
});

describe("metadata search", () => {
  beforeEach(() => {
    book("ficciones", "Ficciones", ["Jorge Luis Borges"], ["Fiction"]);
    book("aleph", "El Aleph", ["Jorge Luis Borges"], ["Fiction", "Infinity"]);
    book(
      "infinity",
      "Everything and More",
      ["David Foster Wallace"],
      ["Mathematics", "Infinity"],
    );
    book("strasse", "Die Straße", ["Anonymous"]);
    book("percent", "100% Pure", ["Q_Author"]);
  });

  it("requires every term to match some title, author or subject, ignoring case", () => {
    expect(ids({ ...view("all"), text: "BORGES" })).toEqual([
      "aleph",
      "ficciones",
    ]);
    // Terms may match different fields of the same book.
    expect(ids({ ...view("all"), text: "  borges   infinity " })).toEqual([
      "aleph",
    ]);
    expect(ids({ ...view("all"), text: "wallace INFIN" })).toEqual([
      "infinity",
    ]);
    expect(ids({ ...view("all"), text: "borges mathematics" })).toEqual([]);
    expect(ids({ ...view("all"), text: "STRASSE" })).toEqual(["strasse"]);
    expect(ids({ ...view("all"), text: "  " })).toHaveLength(5);
  });

  it("treats SQL wildcard characters as literal text", () => {
    expect(ids({ ...view("all"), text: "%" })).toEqual(["percent"]);
    expect(ids({ ...view("all"), text: "_" })).toEqual(["percent"]);
    expect(ids({ ...view("all"), text: "q_a" })).toEqual(["percent"]);
  });

  it("filters by whole author or subject names, ignoring case", () => {
    expect(ids({ ...view("all"), author: "jorge luis BORGES" })).toEqual([
      "aleph",
      "ficciones",
    ]);
    expect(ids({ ...view("all"), author: "Borges" })).toEqual([]);
    expect(ids({ ...view("all"), subject: "infinity" })).toEqual([
      "aleph",
      "infinity",
    ]);
    expect(ids({ ...view("all"), subject: "Infinity", text: "aleph" })).toEqual(
      ["aleph"],
    );
    expect(listFilterTerms(database, view("all"))).toEqual({
      authors: [
        { name: "Anonymous", count: 1 },
        { name: "David Foster Wallace", count: 1 },
        { name: "Jorge Luis Borges", count: 2 },
        { name: "Q_Author", count: 1 },
      ],
      subjects: [
        { name: "Fiction", count: 2 },
        { name: "Infinity", count: 2 },
        { name: "Mathematics", count: 1 },
      ],
    });
  });

  it("searches only the selected view; archived results need the toggle", () => {
    const borges = section("Borges");
    const essays = section("Essays", borges);
    addBooksToSection(database, essays, ["aleph"]);
    addBooksToSection(database, section("Maths"), ["infinity"]);
    expect(
      ids({ ...view("section", { sectionId: borges }), text: "infinity" }),
    ).toEqual(["aleph"]);
    expect(ids({ ...view("all"), text: "infinity" })).toEqual([
      "aleph",
      "infinity",
    ]);
    archiveBook(database, "aleph");
    expect(ids({ ...view("all"), text: "infinity" })).toEqual(["infinity"]);
    expect(
      ids({ ...view("all"), text: "infinity", includeArchived: true }),
    ).toEqual(["aleph", "infinity"]);
    expect(ids({ ...view("archive"), text: "infinity" })).toEqual(["aleph"]);
    expect(ids({ ...view("archive"), text: "ficciones" })).toEqual([]);
    expect(
      listFilterTerms(database, view("section", { sectionId: borges })),
    ).toEqual({ authors: [], subjects: [] });
  });

  it("rejects malformed queries and missing sections", () => {
    for (const query of [
      undefined,
      { view: { kind: "trash" } },
      { view: { kind: "section" } },
      { view: { kind: "all" }, includeArchived: "yes" },
      { view: { kind: "all" }, text: 7 },
      { view: { kind: "all" }, text: "x".repeat(1001) },
    ])
      expect(failure(() => queryBooks(database, query)).code).toBe("invalid");
    expect(
      failure(() =>
        queryBooks(database, view("section", { sectionId: "nope" })),
      ).code,
    ).toBe("unknown-section");
  });
});

describe("sections and memberships", () => {
  it("one book in two nested branches is listed once, and deletion keeps it", () => {
    book("b1", "Shared");
    book("b2", "Only history");
    book("b3", "Elsewhere");
    const history = section("History");
    const rome = section("Rome", history);
    const empire = section("Empire", rome);
    const greece = section("Greece", history);
    const other = section("Other");
    addBooksToSection(database, empire, ["b1"]);
    addBooksToSection(database, greece, ["b1", "b2"]);
    addBooksToSection(database, other, ["b1", "b3"]);

    expect(ids(view("section", { sectionId: history }))).toEqual(["b2", "b1"]);
    expect(counts(listSections(database))).toEqual({
      History: 2,
      Greece: 2,
      Rome: 1,
      Empire: 1,
      Other: 2,
    });
    expect(previewSectionDeletion(database, history)).toEqual({
      sections: 4,
      books: 2,
      unfiled: 1, // b2; b1 is still in Other.
    });

    expect(deleteSection(database, history)).toEqual({
      sections: 4,
      books: 2,
      unfiled: 1,
    });
    reopen();
    expect(listSections(database).map((node) => node.name)).toEqual(["Other"]);
    expect(ids(view("all"))).toEqual(["b3", "b2", "b1"]);
    expect(ids(view("unfiled"))).toEqual(["b2"]);
    expect(ids(view("section", { sectionId: other }))).toEqual(["b3", "b1"]);
    expect(getBook(database, "b1").sectionIds).toEqual([other]);
  });

  it("keeps names trimmed and unique among siblings, ignoring case", () => {
    const fiction = section("  Fiction ");
    expect(listSections(database)[0]?.name).toBe("Fiction");
    expect(failure(() => section("FICTION")).code).toBe("name-conflict");
    expect(failure(() => section("fiction  ")).code).toBe("name-conflict");
    const nested = section("fiction", fiction); // Different parent.
    expect(failure(() => section("Fiction", fiction)).code).toBe(
      "name-conflict",
    );
    for (const name of ["", "   ", 5, undefined])
      expect(failure(() => section(name as string)).code).toBe("invalid");
    expect(failure(() => section("Child", "missing")).code).toBe(
      "unknown-section",
    );

    renameSection(database, nested, "FICTION"); // Case change of itself.
    expect(listSections(database)[0]?.children[0]?.name).toBe("FICTION");
    const poetry = section("Poetry");
    expect(failure(() => renameSection(database, poetry, "fiction")).code).toBe(
      "name-conflict",
    );
    expect(failure(() => renameSection(database, poetry, " ")).code).toBe(
      "invalid",
    );
    expect(listSections(database).map((node) => node.name)).toEqual([
      "Fiction",
      "Poetry",
    ]);
  });

  it("moves branches, rejecting cycles and destination name conflicts", () => {
    const a = section("A");
    const b = section("B", a);
    const c = section("C", b);
    const other = section("Other");
    const clash = section("B", other);
    for (const target of [a, b, c])
      expect(failure(() => moveSection(database, a, target)).code).toBe(
        "section-cycle",
      );
    expect(failure(() => moveSection(database, clash, a)).code).toBe(
      "name-conflict",
    );
    expect(failure(() => moveSection(database, c, "missing")).code).toBe(
      "unknown-section",
    );

    book("deep", "Deep");
    addBooksToSection(database, c, ["deep"]);
    moveSection(database, b, null);
    const roots = listSections(database);
    expect(roots.map((node) => [node.name, node.bookCount])).toEqual([
      ["A", 0],
      ["B", 1],
      ["Other", 0],
    ]);
    expect(roots[1]?.children.map((node) => node.name)).toEqual(["C"]);
  });

  it("adds without removing other memberships and removes without deleting", () => {
    book("b1", "One");
    book("b2", "Two");
    const first = section("First");
    const second = section("Second");
    expect(addBooksToSection(database, first, ["b1", "b2", "b1"])).toEqual({
      added: 2,
    });
    expect(addBooksToSection(database, first, ["b1"])).toEqual({ added: 0 });
    addBooksToSection(database, second, ["b1"]);
    expect(getBook(database, "b1").sectionIds.sort()).toEqual(
      [first, second].sort(),
    );
    expect(removeBooksFromSection(database, first, ["b1"])).toEqual({
      removed: 1,
    });
    expect(getBook(database, "b1").sectionIds).toEqual([second]);
    removeBooksFromSection(database, second, ["b1"]);
    expect(ids(view("unfiled"))).toEqual(["b1"]);

    // All or nothing: one unknown or deleted book adds none of the list.
    book("gone", "Gone");
    softDelete("gone");
    for (const list of [
      ["b1", "missing"],
      ["b1", "gone"],
    ])
      expect(failure(() => addBooksToSection(database, first, list)).code).toBe(
        "unknown-book",
      );
    expect(ids(view("section", { sectionId: first }))).toEqual(["b2"]);
    expect(
      failure(() => addBooksToSection(database, "missing", ["b1"])).code,
    ).toBe("unknown-section");
    expect(failure(() => addBooksToSection(database, first, "b1")).code).toBe(
      "invalid",
    );
  });

  it("counts only visible books unless archived are included", () => {
    book("b1", "One");
    book("b2", "Two");
    const shelf = section("Shelf");
    addBooksToSection(database, shelf, ["b1", "b2"]);
    archiveBook(database, "b2");
    expect(listSections(database)[0]?.bookCount).toBe(1);
    expect(
      listSections(database, { includeArchived: true })[0]?.bookCount,
    ).toBe(2);
    // An archived book keeps its sections.
    expect(getBook(database, "b2").sectionIds).toEqual([shelf]);
  });
});

describe("reading status and Archive transitions", () => {
  const state = (id: string) => {
    const { status, archived } = getBook(database, id);
    return { status, archived };
  };
  const pdfPage = (n: number) => ({ format: "pdf", page: n, x: 0, y: 0 });
  function readTo(id: string, pageNumber: number) {
    const grant = beginReaderSession(database, id);
    saveProgress(database, {
      bookId: id,
      revisionId: grant.revisionId,
      generation: grant.generation,
      sequence: 1,
      location: pdfPage(pageNumber),
      sizing: { fontSize: 16, zoom: 1 },
    });
    return grant;
  }

  it("follows the specification table", () => {
    book("b", "Book");
    expect(state("b")).toEqual({ status: "unread", archived: false });

    // First successful open starts reading; a later open preserves it.
    expect(recordSuccessfulOpen(database, "b", 10)).toMatchObject({
      status: "reading",
      lastOpenedAt: 10,
    });
    readTo("b", 7);
    recordSuccessfulOpen(database, "b", 20);
    expect(state("b")).toEqual({ status: "reading", archived: false });

    // Finish keeps the position; opening for reference stays Finished.
    markFinished(database, "b");
    recordSuccessfulOpen(database, "b", 30);
    expect(getBook(database, "b")).toMatchObject({
      status: "finished",
      lastOpenedAt: 30,
    });
    expect(beginReaderSession(database, "b").location).toEqual(pdfPage(7));

    // Archive and unarchive preserve status and position.
    expect(archiveBook(database, "b", 40)).toMatchObject({
      status: "finished",
      archived: true,
      archivedAt: 40,
    });
    archiveBook(database, "b", 50); // Already archived: keeps its time.
    expect(getBook(database, "b").archivedAt).toBe(40);
    unarchiveBook(database, "b");
    expect(state("b")).toEqual({ status: "finished", archived: false });
    expect(beginReaderSession(database, "b").location).toEqual(pdfPage(7));

    // Finish does not unarchive.
    archiveBook(database, "b");
    markFinished(database, "b");
    expect(state("b")).toEqual({ status: "finished", archived: true });
  });

  it("opening an archived unread book for reference keeps it unread and archived", () => {
    book("b", "Book");
    archiveBook(database, "b");
    expect(recordSuccessfulOpen(database, "b", 5)).toMatchObject({
      status: "unread",
      archived: true,
      lastOpenedAt: 5,
    });
    reopen();
    expect(state("b")).toEqual({ status: "unread", archived: true });
  });

  it("Start Rereading unarchives, resets the position and retires the open session", () => {
    book("b", "Book");
    book("other", "Other");
    recordSuccessfulOpen(database, "b");
    const open = readTo("b", 9);
    readTo("other", 4);
    markFinished(database, "b");
    archiveBook(database, "b");

    expect(startRereading(database, "b")).toMatchObject({
      status: "reading",
      archived: false,
      archivedAt: null,
    });
    // The old session's late write cannot restore the old position.
    let rejected: unknown;
    try {
      saveProgress(database, {
        bookId: "b",
        revisionId: open.revisionId,
        generation: open.generation,
        sequence: 2,
        location: pdfPage(9),
        sizing: { fontSize: 16, zoom: 1 },
      });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as ProgressError).code).toBe("stale-session");
    reopen();
    expect(beginReaderSession(database, "b").location).toBeNull();
    // Sizing is per book and survives; another book's position is untouched.
    expect(beginReaderSession(database, "b").sizing).toEqual({
      fontSize: 16,
      zoom: 1,
    });
    expect(beginReaderSession(database, "other").location).toEqual(pdfPage(4));
  });

  it("rejects transitions for unknown or deleted books without changes", () => {
    book("b", "Book");
    softDelete("b");
    for (const action of [
      recordSuccessfulOpen,
      markFinished,
      archiveBook,
      unarchiveBook,
      startRereading,
    ]) {
      expect(failure(() => action(database, "b")).code).toBe("unknown-book");
      expect(failure(() => action(database, "missing")).code).toBe(
        "unknown-book",
      );
      expect(failure(() => action(database, 42)).code).toBe("invalid");
    }
    expect(
      database.prepare("SELECT reading_status, archived_at FROM books").get(),
    ).toEqual({ reading_status: "unread", archived_at: null });
  });
});

describe("manual metadata", () => {
  const flags = (id: string) =>
    database
      .prepare(
        "SELECT title_manual, authors_manual, subjects_manual FROM books WHERE id = ?",
      )
      .get(id);

  it("stores ordered authors and case-insensitively unique subjects as manual", () => {
    book("b", "file-name");
    expect(
      editMetadata(database, "b", {
        title: "  The Book of Sand ",
        authors: ["Jorge Luis Borges", " ", "Norman Thomas di Giovanni"],
        subjects: ["Fiction", "fiction", " FICTION ", "Short Stories"],
      }),
    ).toMatchObject({
      title: "The Book of Sand",
      authors: ["Jorge Luis Borges", "Norman Thomas di Giovanni"],
      subjects: ["Fiction", "Short Stories"],
    });
    expect(flags("b")).toEqual({
      title_manual: 1,
      authors_manual: 1,
      subjects_manual: 1,
    });

    // Reordering is preserved; an empty list is an intentional, manual clear.
    editMetadata(database, "b", {
      authors: ["Norman Thomas di Giovanni", "Jorge Luis Borges"],
      subjects: [],
    });
    reopen();
    expect(getBook(database, "b")).toMatchObject({
      title: "The Book of Sand",
      authors: ["Norman Thomas di Giovanni", "Jorge Luis Borges"],
      subjects: [],
    });
    expect(flags("b")).toMatchObject({ subjects_manual: 1 });
  });

  it("marks only the edited fields manual", () => {
    book("b", "Book");
    editMetadata(database, "b", { authors: ["A"] });
    expect(flags("b")).toEqual({
      title_manual: 0,
      authors_manual: 1,
      subjects_manual: 0,
    });
  });

  it("rejects invalid edits and commits nothing when storage fails midway", () => {
    book("b", "Book", ["Original"]);
    for (const edit of [
      { title: "  " },
      { title: 3 },
      { authors: "Borges" },
      { subjects: [1] },
    ])
      expect(failure(() => editMetadata(database, "b", edit)).code).toBe(
        "invalid",
      );
    expect(failure(() => editMetadata(database, "gone", {})).code).toBe(
      "unknown-book",
    );

    // Temporary schema is per connection and does not alter the catalog.
    database.exec(`CREATE TEMP TRIGGER fail_subjects BEFORE INSERT ON book_subjects
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const error = failure(() =>
      editMetadata(database, "b", {
        title: "Changed",
        authors: ["Changed"],
        subjects: ["Changed"],
      }),
    );
    expect(error.code).toBe("storage-failed");
    expect(error.message).toContain("injected failure");
    database.exec("DROP TRIGGER fail_subjects");
    expect(getBook(database, "b")).toMatchObject({
      title: "Book",
      authors: ["Original"],
      subjects: [],
    });
    expect(flags("b")).toMatchObject({ title_manual: 0 });
  });
});

describe("a 500-entry catalog", () => {
  it("returns independently known search, filter and section results", () => {
    const fiction = section("Fiction");
    const nested = section("Nested", fiction);
    for (let i = 0; i < 500; i++) {
      const id = `book-${String(i).padStart(3, "0")}`;
      addBook(database, {
        book: id,
        revision: `${id}-r`,
        title: `Volume ${i}`,
      });
    }
    for (let i = 0; i < 500; i += 7)
      editMetadata(database, `book-${String(i).padStart(3, "0")}`, {
        authors: ["Seven Author"],
        subjects: ["Septenary"],
      });
    const tens = Array.from(
      { length: 50 },
      (_, i) => `book-${String(i * 10).padStart(3, "0")}`,
    );
    addBooksToSection(database, nested, tens);
    for (let i = 0; i < 500; i += 3)
      archiveBook(database, `book-${String(i).padStart(3, "0")}`);

    // Multiples of 7 below 500: 72. Of those, multiples of 21 (24) are archived.
    expect(ids({ ...view("all"), text: "septenary" })).toHaveLength(48);
    expect(
      ids({ ...view("all"), author: "SEVEN AUTHOR", includeArchived: true }),
    ).toHaveLength(72);
    // Multiples of 10: 50; of 30: 17 archived. Multiples of 70 not of 3: 5.
    expect(ids(view("section", { sectionId: fiction }))).toHaveLength(33);
    expect(
      ids({ ...view("section", { sectionId: fiction }), text: "seven" }),
    ).toEqual(["book-070", "book-140", "book-280", "book-350", "book-490"]);
    expect(ids(view("all"))).toHaveLength(333);
    expect(ids(view("all")).slice(0, 3)).toEqual([
      "book-001",
      "book-002",
      "book-004",
    ]);
  });
});
