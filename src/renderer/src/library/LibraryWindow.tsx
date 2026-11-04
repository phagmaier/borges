import { useCallback, useEffect, useId, useState } from "react";
import type {
  BookSummary,
  FilterTerm,
  LibraryResult,
  RuntimeInfo,
  SectionNode,
} from "../../../shared/runtime";
import { developmentBooks } from "../../../shared/windows";
import { BookResults, type Layout, RESULT_BATCH } from "./BookResults";
import { SectionActions } from "./SectionActions";
import { SelectionBar } from "./SelectionBar";
import { Sidebar } from "./Sidebar";
import "./library.css";
import {
  type Destination,
  destinationTitle,
  emptyViewMessage,
  findSection,
  sameDestination,
} from "./views";

interface Terms {
  authors: FilterTerm[];
  subjects: FilterTerm[];
}

/** Keep the previous state when a refresh returns identical data, so an
 * unrelated change does not re-render every book. */
function unlessSame<T>(next: T) {
  return (previous: T) =>
    JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function unwrap<T>(result: LibraryResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.message), result);
  return result.value;
}

/**
 * The library window: sidebar destinations, selected-view search with
 * author/subject filters and the include-archived toggle, and a grid or list
 * of books. Every change (here or in a reader) arrives as `library:changed`
 * and triggers a fresh query; replies to superseded queries are dropped.
 */
export function LibraryWindow({ runtime }: { runtime: RuntimeInfo | null }) {
  const [destination, setDestination] = useState<Destination>({ kind: "all" });
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [subject, setSubject] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [layout, setLayout] = useState<Layout>("grid");
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [onlyArchived, setOnlyArchived] = useState(false);
  const [sections, setSections] = useState<SectionNode[] | null>(null);
  const [terms, setTerms] = useState<Terms>({ authors: [], subjects: [] });
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(RESULT_BATCH);
  const showMore = useCallback(
    () => setLimit((value) => value + RESULT_BATCH),
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const ids = useId();

  const view = destination.kind === "trash" ? null : destination;
  const archiveScope = destination.kind === "archive" || includeArchived;
  const narrowed = text.trim() !== "" || author !== "" || subject !== "";

  // Selection belongs to the view where it was made; results that leave the
  // view (after a removal, say) leave the selection too.
  useEffect(() => {
    void destination;
    setSelected(new Set());
    setNotice(null);
  }, [destination]);
  useEffect(() => {
    if (!books) return;
    const present = new Set(books.map((book) => book.id));
    setSelected((current) =>
      [...current].every((id) => present.has(id))
        ? current
        : new Set([...current].filter((id) => present.has(id))),
    );
  }, [books]);

  const toggle = useCallback((bookId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  // A new view or query starts again from the first batch; a refresh of the
  // same query keeps what has been shown.
  useEffect(() => {
    void [destination, text, author, subject, includeArchived];
    setLimit(RESULT_BATCH);
  }, [destination, text, author, subject, includeArchived]);

  useEffect(() => {
    // Main announces every catalog change, including readers' opens.
    return window.borges.library.onChanged(() =>
      setRevision((value) => value + 1),
    );
  }, []);

  useEffect(() => {
    void revision;
    let current = true;
    window.borges.library
      .sections({ includeArchived: archiveScope })
      .then((result) => {
        if (current)
          setSections(unlessSame<SectionNode[] | null>(unwrap(result)));
      })
      .catch((reason: unknown) => current && setError(String(reason)));
    return () => {
      current = false;
    };
  }, [archiveScope, revision]);

  useEffect(() => {
    void revision;
    let current = true;
    if (destination.kind === "trash") {
      setTerms({ authors: [], subjects: [] });
      return;
    }
    window.borges.library
      .filterTerms({ view: destination, includeArchived })
      .then((result) => {
        if (current) setTerms(unlessSame(unwrap(result)));
      })
      .catch(() => current && setTerms({ authors: [], subjects: [] }));
    return () => {
      current = false;
    };
  }, [destination, includeArchived, revision]);

  useEffect(() => {
    void revision;
    let current = true;
    if (destination.kind === "trash") {
      setBooks([]);
      return;
    }
    const view = destination;
    const query = {
      view,
      includeArchived,
      ...(text.trim() ? { text } : {}),
      ...(author ? { author } : {}),
      ...(subject ? { subject } : {}),
    };
    (async () => {
      const result = await window.borges.library.books(query);
      if (!current) return;
      if (!result.ok && result.code === "unknown-section") {
        // The selected section was deleted; fall back to All Books.
        setDestination({ kind: "all" });
        return;
      }
      const found = unwrap(result);
      // An empty All Books may only be hiding archived books.
      let archivedOnly = false;
      if (found.length === 0 && view.kind === "all" && !includeArchived) {
        const all = await window.borges.library.books({
          view,
          includeArchived: true,
        });
        archivedOnly = all.ok && all.value.length > 0;
      }
      if (!current) return;
      setBooks(unlessSame<BookSummary[] | null>(found));
      setOnlyArchived(archivedOnly);
      setError(null);
    })().catch((reason: unknown) => current && setError(String(reason)));
    return () => {
      current = false;
    };
  }, [destination, text, author, subject, includeArchived, revision]);

  function select(next: Destination) {
    if (sameDestination(next, destination)) return;
    // Filter choices belong to a view; the search text carries over.
    setAuthor("");
    setSubject("");
    setBooks(null);
    setDestination(next);
  }

  function clearNarrowing() {
    setText("");
    setAuthor("");
    setSubject("");
  }

  function open(book: BookSummary) {
    setError(null);
    window.borges.library
      .openBook(book.id)
      .then(unwrap)
      .catch((reason: unknown) => setError(String(reason)));
  }

  function development(operation: Promise<void>) {
    setError(null);
    operation.catch((reason: unknown) => setError(String(reason)));
  }

  const title = destinationTitle(destination, sections ?? []);
  const currentSection =
    destination.kind === "section"
      ? findSection(sections ?? [], destination.sectionId)
      : undefined;
  const showSection = (id: string) =>
    select({ kind: "section", sectionId: id });
  const count = books?.length ?? 0;
  return (
    <div className="library">
      <Sidebar
        selected={destination}
        sections={sections}
        onSelect={select}
        onSectionCreated={showSection}
      />
      <main className="library-main" aria-labelledby={`${ids}-title`}>
        <header className="toolbar">
          <h1 id={`${ids}-title`}>{title}</h1>
          {view ? (
            <search className="filters">
              <label>
                <span>Search {title}</span>
                <input
                  type="search"
                  value={text}
                  placeholder="Title, author or subject"
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <label>
                <span>Author</span>
                <select
                  value={author}
                  onChange={(event) => setAuthor(event.target.value)}
                >
                  <option value="">Any author</option>
                  {terms.authors.map((term) => (
                    <option key={term.name} value={term.name}>
                      {term.name} ({term.count})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Subject</span>
                <select
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                >
                  <option value="">Any subject</option>
                  {terms.subjects.map((term) => (
                    <option key={term.name} value={term.name}>
                      {term.name} ({term.count})
                    </option>
                  ))}
                </select>
              </label>
              {destination.kind === "archive" ? null : (
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={includeArchived}
                    onChange={(event) =>
                      setIncludeArchived(event.target.checked)
                    }
                  />
                  <span>Include archived</span>
                </label>
              )}
            </search>
          ) : null}
          <fieldset className="layout">
            <legend className="sr-only">Layout</legend>
            {(["grid", "list"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={layout === option}
                onClick={() => setLayout(option)}
              >
                {option === "grid" ? "Grid" : "List"}
              </button>
            ))}
          </fieldset>
        </header>
        {currentSection && sections ? (
          <SectionActions
            section={currentSection}
            sections={sections}
            onCreated={showSection}
          />
        ) : null}
        {selected.size > 0 ? (
          <SelectionBar
            selected={(books ?? []).filter((book) => selected.has(book.id))}
            sections={sections ?? []}
            currentSection={currentSection}
            onClear={() => setSelected(new Set())}
            onMessage={(message, problem) =>
              problem ? setError(message) : setNotice(message)
            }
          />
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
        <p className="result-count" aria-live="polite">
          {books === null
            ? "Loading…"
            : `${count} ${count === 1 ? "book" : "books"}`}
        </p>
        {books === null ? null : books.length > 0 ? (
          <BookResults
            books={books}
            layout={layout}
            limit={limit}
            onShowMore={showMore}
            selected={selected}
            onToggle={toggle}
            onOpen={open}
          />
        ) : narrowed ? (
          <div className="empty">
            <p>No books in {title} match this search.</p>
            <button type="button" onClick={clearNarrowing}>
              Clear search and filters
            </button>
          </div>
        ) : onlyArchived ? (
          <div className="empty">
            <p>Every book in this library is archived.</p>
            <button type="button" onClick={() => select({ kind: "archive" })}>
              Show Archive
            </button>
          </div>
        ) : (
          <div className="empty">
            <p>{emptyViewMessage(destination)}</p>
            {destination.kind === "all" ? (
              <p className="quiet">
                Importing PDF and EPUB files arrives in a later build.
              </p>
            ) : null}
          </div>
        )}
        <footer className="development">
          <h2>Development</h2>
          <div className="actions">
            {developmentBooks.map((book) => (
              <button
                key={book.id}
                type="button"
                onClick={() =>
                  development(window.development.openReader(book.id))
                }
              >
                Open {book.title}
              </button>
            ))}
            <button
              type="button"
              onClick={() => development(window.development.quit())}
            >
              Quit application
            </button>
          </div>
          <details>
            <summary>Runtime diagnostics</summary>
            {runtime ? (
              <dl>
                <dt>Electron</dt>
                <dd>{runtime.electron}</dd>
                <dt>Chromium</dt>
                <dd>{runtime.chromium}</dd>
                <dt>Embedded Node</dt>
                <dd>{runtime.node}</dd>
                <dt>SQLite</dt>
                <dd data-testid="sqlite-version">{runtime.sqlite}</dd>
                <dt>Catalog schema</dt>
                <dd data-testid="schema-version">
                  {runtime.catalog.schemaVersion}
                </dd>
                <dt>Library identity</dt>
                <dd data-testid="library-id">{runtime.catalog.libraryId}</dd>
                <dt>Library folder</dt>
                <dd data-testid="library-root">{runtime.catalog.root}</dd>
              </dl>
            ) : (
              <p>Checking the runtime…</p>
            )}
          </details>
        </footer>
      </main>
    </div>
  );
}
