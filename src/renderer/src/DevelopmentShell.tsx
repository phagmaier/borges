import { useEffect, useState } from "react";
import type { RuntimeInfo } from "../../shared/runtime";
import { type DevelopmentWindow, developmentBooks } from "../../shared/windows";

export function DevelopmentShell() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<DevelopmentWindow | null>(null);

  function run(operation: Promise<void>) {
    setError(null);
    operation.catch((reason: unknown) => setError(String(reason)));
  }

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
      <p>
        The desktop shell is ready. Its library catalog is open and locked; no
        books are imported yet.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {identity?.kind === "library" ? (
        <section aria-label="Window lifecycle spike">
          <h2>Reader windows</h2>
          <p>Open independent readers with small known diagnostic fixtures.</p>
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
      ) : identity?.kind === "reader" ? (
        <section aria-label="Reader shell">
          <h2>Reader shell</h2>
          <p>
            Reader integration spike. Closing the library leaves this window
            open.
          </p>
          <iframe
            title="Book content"
            src={`borges://reader/content.html?book=${identity.book.id}`}
            sandbox="allow-scripts allow-same-origin"
          />
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
        This is a diagnostic spike. Automatic progress saves and the library
        interface remain pending.
      </p>
    </main>
  );
}
