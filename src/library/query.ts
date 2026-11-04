import type { DatabaseSync } from "node:sqlite";
import type { BookFormat } from "./formats.ts";
import {
  collator,
  foldKey,
  LibraryError,
  requireId,
  searchTerms,
  storage,
} from "./rules.ts";

// Library browsing and metadata search. Deleted books (Trash) never appear
// here; archived books appear only in Archive or when a query explicitly
// includes them. That scoping lives in `scopedBooks` and nowhere else.

export type ReadingStatus = "unread" | "reading" | "finished";

export type LibraryView =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "section"; sectionId: string }
  | { kind: "reading" }
  | { kind: "finished" }
  | { kind: "archive" };

export interface BookQuery {
  view: LibraryView;
  /** Whitespace-separated terms; each must match a title, author or subject. */
  text?: string;
  /** Only books with this author (ignoring case). */
  author?: string;
  /** Only books with this subject label (ignoring case). */
  subject?: string;
  /** Show archived books in ordinary views. Archive always shows only them. */
  includeArchived?: boolean;
}

export interface BookSummary {
  id: string;
  title: string;
  authors: string[];
  subjects: string[];
  format: BookFormat;
  status: ReadingStatus;
  archived: boolean;
  archivedAt: number | null;
  lastOpenedAt: number | null;
  /** Direct memberships, not ancestors. */
  sectionIds: string[];
}

export interface SectionNode {
  id: string;
  name: string;
  parentId: string | null;
  /** Unique books in this section and its descendants. */
  bookCount: number;
  children: SectionNode[];
}

export interface FilterTerm {
  name: string;
  /** Books in the scope that carry this term. */
  count: number;
}

const VIEW_KINDS = new Set([
  "all",
  "unfiled",
  "section",
  "reading",
  "finished",
  "archive",
]);

/** Rebuild a query from untrusted input, keeping only known fields. */
export function parseBookQuery(input: unknown): BookQuery {
  const value = (input ?? {}) as Record<string, unknown>;
  const view = parseView(value.view);
  const text = optionalText(value.text, "Search text");
  const author = optionalText(value.author, "Author filter");
  const subject = optionalText(value.subject, "Subject filter");
  if (
    value.includeArchived !== undefined &&
    typeof value.includeArchived !== "boolean"
  )
    throw new LibraryError("invalid", "Include archived must be on or off.");
  return {
    view,
    ...(text === undefined ? {} : { text }),
    ...(author === undefined ? {} : { author }),
    ...(subject === undefined ? {} : { subject }),
    includeArchived: value.includeArchived === true,
  };
}

function parseView(input: unknown): LibraryView {
  const view = (input ?? {}) as Record<string, unknown>;
  if (typeof view.kind !== "string" || !VIEW_KINDS.has(view.kind))
    throw new LibraryError("invalid", "Unknown library view.");
  if (view.kind === "section")
    return { kind: "section", sectionId: requireId(view.sectionId, "section") };
  return { kind: view.kind } as LibraryView;
}

function optionalText(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 1000)
    throw new LibraryError("invalid", `${what} must be short text.`);
  return value;
}

/** Books in the selected view matching the search and filters, sorted. */
export function queryBooks(
  database: DatabaseSync,
  input: unknown,
): BookSummary[] {
  const query = parseBookQuery(input);
  return storage(() => {
    const books = scopedBooks(database, query.view, query.includeArchived);
    const terms = searchTerms(query.text ?? "");
    const author = query.author ? foldKey(query.author) : "";
    const subject = query.subject ? foldKey(query.subject) : "";
    const matches = books.filter((book) => {
      if (author && !book.authors.some((name) => foldKey(name) === author))
        return false;
      if (subject && !book.subjects.some((label) => foldKey(label) === subject))
        return false;
      if (terms.length === 0) return true;
      const fields = [book.title, ...book.authors, ...book.subjects].map(
        foldKey,
      );
      return terms.every((term) =>
        fields.some((field) => field.includes(term)),
      );
    });
    return matches.sort(viewOrder(query.view));
  }, "read");
}

/** Authors and subjects present in a view, for filter choices. */
export function listFilterTerms(
  database: DatabaseSync,
  input: unknown,
): { authors: FilterTerm[]; subjects: FilterTerm[] } {
  const query = parseBookQuery(input);
  return storage(() => {
    const books = scopedBooks(database, query.view, query.includeArchived).sort(
      defaultOrder,
    );
    return {
      authors: countTerms(books.map((book) => book.authors)),
      subjects: countTerms(books.map((book) => book.subjects)),
    };
  }, "read");
}

function countTerms(perBook: string[][]): FilterTerm[] {
  // The first spelling in default book order names a case-insensitive group.
  const terms = new Map<string, FilterTerm>();
  for (const names of perBook) {
    const seen = new Set<string>();
    for (const name of names) {
      const key = foldKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const term = terms.get(key);
      if (term) term.count += 1;
      else terms.set(key, { name, count: 1 });
    }
  }
  return [...terms.values()].sort((a, b) => collator.compare(a.name, b.name));
}

/** One live book (archived or not), or `unknown-book` if absent or deleted. */
export function getBook(database: DatabaseSync, bookId: string): BookSummary {
  const id = requireId(bookId, "book");
  return storage(() => readBook(database, id), "read");
}

/** `getBook` for services already inside their own transaction. */
export function readBook(database: DatabaseSync, id: string): BookSummary {
  const [book] = selectBooks(database, "AND b.id = ?", [id]);
  if (!book)
    throw new LibraryError("unknown-book", "This book is not in the library.");
  return book;
}

/** Section tree with unique-book counts, children sorted by name. */
export function listSections(
  database: DatabaseSync,
  options: { includeArchived?: boolean } = {},
): SectionNode[] {
  const includeArchived = options.includeArchived === true;
  return storage(() => {
    const rows = database
      .prepare("SELECT id, name, parent_id FROM sections")
      .all() as { id: string; name: string; parent_id: string | null }[];
    const counts = new Map(
      (
        database
          .prepare(
            `WITH RECURSIVE closure(ancestor, id) AS (
               SELECT id, id FROM sections
               UNION ALL
               SELECT closure.ancestor, sections.id FROM sections
                 JOIN closure ON sections.parent_id = closure.id)
             SELECT closure.ancestor AS id, count(DISTINCT m.book_id) AS books
             FROM closure
             JOIN section_memberships m ON m.section_id = closure.id
             JOIN books b ON b.id = m.book_id
             WHERE b.deleted_at IS NULL ${includeArchived ? "" : "AND b.archived_at IS NULL"}
             GROUP BY closure.ancestor`,
          )
          .all() as { id: string; books: number }[]
      ).map((row) => [row.id, Number(row.books)]),
    );
    const nodes = new Map<string, SectionNode>(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          parentId: row.parent_id,
          bookCount: counts.get(row.id) ?? 0,
          children: [],
        },
      ]),
    );
    const roots: SectionNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    const sort = (list: SectionNode[]) => {
      list.sort(
        (a, b) => collator.compare(a.name, b.name) || compareIds(a.id, b.id),
      );
      for (const node of list) sort(node.children);
    };
    sort(roots);
    return roots;
  }, "read");
}

/** Live books in a view. The only place deletion/archive scope is applied. */
function scopedBooks(
  database: DatabaseSync,
  view: LibraryView,
  includeArchived = false,
): BookSummary[] {
  if (view.kind === "archive")
    return selectBooks(database, "AND b.archived_at IS NOT NULL", []);
  const archive = includeArchived ? "" : "AND b.archived_at IS NULL";
  switch (view.kind) {
    case "all":
      return selectBooks(database, archive, []);
    case "reading":
    case "finished":
      return selectBooks(database, `${archive} AND b.reading_status = ?`, [
        view.kind,
      ]);
    case "unfiled":
      return selectBooks(
        database,
        `${archive} AND NOT EXISTS (SELECT 1 FROM section_memberships m WHERE m.book_id = b.id)`,
        [],
      );
    case "section": {
      const exists = database
        .prepare("SELECT 1 FROM sections WHERE id = ?")
        .get(view.sectionId);
      if (!exists)
        throw new LibraryError(
          "unknown-section",
          "This section no longer exists.",
        );
      return selectBooks(
        database,
        `${archive} AND b.id IN (
           WITH RECURSIVE branch(id) AS (
             SELECT ? UNION SELECT sections.id FROM sections
               JOIN branch ON sections.parent_id = branch.id)
           SELECT m.book_id FROM section_memberships m
             JOIN branch ON m.section_id = branch.id)`,
        [view.sectionId],
      );
    }
  }
}

function selectBooks(
  database: DatabaseSync,
  where: string,
  parameters: string[],
): BookSummary[] {
  const rows = database
    .prepare(
      `SELECT b.id, b.title, b.reading_status AS status, b.archived_at,
         b.last_opened_at, r.format,
         (SELECT json_group_array(name ORDER BY position) FROM book_authors
            WHERE book_id = b.id) AS authors,
         (SELECT json_group_array(label) FROM book_subjects
            WHERE book_id = b.id) AS subjects,
         (SELECT json_group_array(section_id) FROM section_memberships
            WHERE book_id = b.id) AS sections
       FROM books b JOIN revisions r ON r.id = b.current_revision_id
       WHERE b.deleted_at IS NULL ${where}`,
    )
    .all(...parameters) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    authors: JSON.parse(String(row.authors)),
    subjects: (JSON.parse(String(row.subjects)) as string[]).sort(
      collator.compare,
    ),
    format: row.format as BookFormat,
    status: row.status as ReadingStatus,
    archived: row.archived_at !== null,
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    lastOpenedAt:
      row.last_opened_at === null ? null : Number(row.last_opened_at),
    sectionIds: (JSON.parse(String(row.sections)) as string[]).sort(compareIds),
  }));
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Title, then first author (books without one last), then stable ID. */
function defaultOrder(a: BookSummary, b: BookSummary): number {
  const title = collator.compare(a.title, b.title);
  if (title) return title;
  const [first, second] = [a.authors[0], b.authors[0]];
  if (first !== second) {
    if (first === undefined) return 1;
    if (second === undefined) return -1;
    const author = collator.compare(first, second);
    if (author) return author;
  }
  return compareIds(a.id, b.id);
}

/** Most recent first; books without a timestamp after those with one. */
function newestFirst(key: "lastOpenedAt" | "archivedAt") {
  return (a: BookSummary, b: BookSummary) => {
    const [x, y] = [a[key], b[key]];
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    }
    return defaultOrder(a, b);
  };
}

function viewOrder(view: LibraryView) {
  if (view.kind === "reading") return newestFirst("lastOpenedAt");
  if (view.kind === "archive") return newestFirst("archivedAt");
  return defaultOrder;
}
