import type { BookSummary } from "../../../shared/runtime";
import { Cover } from "./Cover";

/** Books shown at most; the strip is a shortcut, not a second listing. */
const SHOWN = 6;

const authorLine = (book: BookSummary) =>
  book.authors.length > 0 ? book.authors.join(", ") : "Unknown author";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function opened(at: number | null): string {
  if (at === null) return "";
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (days === 0) {
    const hours = Math.round((at - Date.now()) / 3_600_000);
    return `Opened ${hours === 0 ? "just now" : relative.format(hours, "hour")}`;
  }
  return `Opened ${relative.format(days, "day")}`;
}

/**
 * All Books' "Continue reading" strip: the unarchived Currently Reading
 * books from the loaded results, most recently opened first. It reuses the
 * results already queried, so it adds no catalog request.
 */
export function ContinueReading({
  books,
  onOpen,
}: {
  books: BookSummary[];
  onOpen(book: BookSummary): void;
}) {
  const reading = books
    .filter((book) => book.status === "reading" && !book.archived)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
    .slice(0, SHOWN);
  if (reading.length === 0) return null;
  return (
    <section className="continue-reading" aria-labelledby="continue-heading">
      <h2 id="continue-heading">Continue reading</h2>
      <div className="continue-books">
        {reading.map((book) => (
          <button
            key={book.id}
            type="button"
            className="continue-book"
            aria-label={`Continue ${book.title}`}
            onClick={() => onOpen(book)}
          >
            <Cover book={book} />
            <span className="continue-text">
              <span className="continue-title">{book.title}</span>
              <span className="continue-authors">{authorLine(book)}</span>
              <span className="continue-opened">
                {opened(book.lastOpenedAt)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
