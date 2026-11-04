import { useEffect, useRef } from "react";
import type { BookSummary } from "../../../shared/runtime";
import { statusLabels } from "./views";

export type Layout = "grid" | "list";

/** Books rendered at a time; more are added as the end comes into view. */
export const RESULT_BATCH = 100;

interface BookResultsProps {
  books: BookSummary[];
  layout: Layout;
  /** How many of `books` to render. */
  limit: number;
  selected: ReadonlySet<string>;
  onToggle(bookId: string): void;
  onShowMore(): void;
  onOpen(book: BookSummary): void;
}

const authorLine = (book: BookSummary) =>
  book.authors.length > 0 ? book.authors.join(", ") : "Unknown author";

/** Placeholder until covers exist (M3-05): format and title initials. */
function CoverPlaceholder({ book }: { book: BookSummary }) {
  const initials = book.title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  return (
    <span className={`cover placeholder ${book.format}`} aria-hidden="true">
      <span className="initials">{initials}</span>
      <span className="format">{book.format.toUpperCase()}</span>
    </span>
  );
}

function Status({ book }: { book: BookSummary }) {
  return (
    <span className="status">
      <span data-testid={`status-${book.id}`}>{statusLabels[book.status]}</span>
      {book.archived ? <span className="badge"> · Archived</span> : null}
    </span>
  );
}

/**
 * Asks for the next batch when the end of the rendered results nears the
 * viewport, so layout and paint stay proportional to what has been browsed
 * rather than to the catalog size. The button serves keyboard users.
 */
function MoreResults({
  remaining,
  onShowMore,
}: {
  remaining: number;
  onShowMore(): void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onShowMore();
      },
      { root: element.closest(".library-main"), rootMargin: "800px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onShowMore]);
  return (
    <div ref={sentinel} className="more-results">
      <button type="button" onClick={onShowMore}>
        Show more books ({remaining} more)
      </button>
    </div>
  );
}

/**
 * Books of the current view. Each book's button is named by its title and
 * opens (or focuses) its reader; Enter and Space work as for any button.
 */
export function BookResults(props: BookResultsProps) {
  const { books, limit, onShowMore } = props;
  const remaining = books.length - limit;
  return (
    <>
      <Rendered {...props} books={books.slice(0, limit)} />
      {remaining > 0 ? (
        <MoreResults remaining={remaining} onShowMore={onShowMore} />
      ) : null}
    </>
  );
}

function SelectBox({
  book,
  selected,
  onToggle,
}: {
  book: BookSummary;
  selected: ReadonlySet<string>;
  onToggle(bookId: string): void;
}) {
  return (
    <input
      type="checkbox"
      className="select"
      aria-label={`Select ${book.title}`}
      checked={selected.has(book.id)}
      onChange={() => onToggle(book.id)}
    />
  );
}

function Rendered({
  books,
  layout,
  selected,
  onToggle,
  onOpen,
}: BookResultsProps) {
  if (layout === "list")
    return (
      <table className="book-list" aria-label="Books">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Selected</span>
            </th>
            <th scope="col">Title</th>
            <th scope="col">Authors</th>
            <th scope="col">Status</th>
            <th scope="col">Format</th>
          </tr>
        </thead>
        <tbody>
          {books.map((book) => (
            <tr key={book.id}>
              <td>
                <SelectBox
                  book={book}
                  selected={selected}
                  onToggle={onToggle}
                />
              </td>
              <th scope="row">
                <button
                  type="button"
                  className="title-button"
                  onClick={() => onOpen(book)}
                >
                  {book.title}
                </button>
              </th>
              <td>{authorLine(book)}</td>
              <td>
                <Status book={book} />
              </td>
              <td>{book.format.toUpperCase()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  return (
    <ul className="book-grid" aria-label="Books">
      {books.map((book) => (
        <li key={book.id} className="book-card">
          <button
            type="button"
            className="title-button"
            onClick={() => onOpen(book)}
          >
            <CoverPlaceholder book={book} />
            <span className="title">{book.title}</span>
          </button>
          <span className="authors">{authorLine(book)}</span>
          <Status book={book} />
          <SelectBox book={book} selected={selected} onToggle={onToggle} />
        </li>
      ))}
    </ul>
  );
}
