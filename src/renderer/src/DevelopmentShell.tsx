import { useEffect, useState } from "react";
import type { BookSummary, RuntimeInfo } from "../../shared/runtime";
import {
  type DevelopmentWindow,
  developmentBooks,
  engineUrl,
} from "../../shared/windows";
import { CatalogReader } from "./CatalogReader";

const statusLabels = {
  unread: "Unread",
  reading: "Currently Reading",
  finished: "Finished",
} as const;

export function DevelopmentShell() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<DevelopmentWindow | null>(null);
  const [books, setBooks] = useState<BookSummary[] | null>(null);

  function run(operation: Promise<void>) {
    setError(null);
    operation.catch((reason: unknown) => setError(String(reason)));
  }

  useEffect(() => {
    if (identity?.kind !== "library") return;
    const refresh = () => {
      window.borges.library
        .books()
        .then(setBooks)
        .catch((reason: unknown) => setError(String(reason)));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [identity]);

  useEffect(() => {
    Promise.all([
      window.development.getRuntimeInfo(),
      window.development.getWindowInfo(),
    ])
      .then(([info, currentWindow]) => {
        setRuntime(info);
        setIdentity(currentWindow);
      })
      .catch((reason: unknown) => {
        setError(String(reason));
      });
  }, []);

  return (
    <main
      className={identity?.kind === "reader" ? "reader-diagnostic" : undefined}
    >
      <p className="eyebrow">Borges</p>
      <h1>
        {identity?.kind === "reader"
          ? identity.book.title
          : "Development environment"}
      </h1>
      <p>The desktop shell is ready. Its library catalog is open and locked.</p>
      {error ? <p role="alert">{error}</p> : null}
      {identity?.kind === "library" ? (
        <>
          <section aria-label="Catalog books">
            <h2>Catalog books</h2>
            {books === null ? (
              <p>Loading the catalog…</p>
            ) : books.length === 0 ? (
              <p>No books have been added to this library yet.</p>
            ) : (
              <ul>
                {books.map((book) => (
                  <li key={book.id}>
                    <button
                      type="button"
                      onClick={() =>
                        run(window.borges.library.openBook(book.id))
                      }
                    >
                      Read {book.title}
                    </button>{" "}
                    <span data-testid={`status-${book.id}`}>
                      {statusLabels[book.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Window lifecycle spike">
            <h2>Reader windows</h2>
            <p>
              Open independent readers with small known diagnostic fixtures.
            </p>
            <div className="actions">
              {developmentBooks.map((book) => (
                <button
                  key={book.id}
                  type="button"
                  onClick={() => run(window.development.openReader(book.id))}
                >
                  Open {book.title}
                </button>
              ))}
            </div>
          </section>
        </>
      ) : identity?.kind === "reader" ? (
        <section aria-label="Reader shell">
          <h2>Reader shell</h2>
          <p>
            Reader integration spike. Closing the library leaves this window
            open.
          </p>
          {identity.book.source === "catalog" ? (
            <CatalogReader />
          ) : (
            <iframe
              title="Book content"
              src={engineUrl(identity.book)}
              sandbox="allow-scripts allow-same-origin"
            />
          )}
          <button
            type="button"
            onClick={() => run(window.development.openLibrary())}
          >
            Open library
          </button>
        </section>
      ) : null}
      <button type="button" onClick={() => run(window.development.quit())}>
        Quit application
      </button>
      {runtime ? (
        <section aria-label="Runtime diagnostics">
          <h2>Runtime diagnostics</h2>
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
        </section>
      ) : (
        <p role="status">Checking the runtime…</p>
      )}
      <p className="note">
        This is a diagnostic spike. Catalog books save their position
        automatically; diagnostic fixtures do not. The library interface remains
        pending.
      </p>
    </main>
  );
}
