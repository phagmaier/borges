import { useEffect, useRef, useState } from "react";
import type { OpenedBook } from "../../shared/runtime";
import { engineUrl } from "../../shared/windows";
import { ReplaceFileDialog } from "./library/ReplaceFileDialog";
import { ReaderLinks } from "./ReaderLinks";
import "./reader.css";

const restorationNotices: Record<string, string | null> = {
  none: null,
  exact: null,
  approximate:
    "The exact saved passage could not be found; reopened at the nearest saved chapter position.",
  beginning:
    "The saved position could not be restored; reading starts at the beginning.",
};

/**
 * Reader shell for a catalog book. It holds the session grant, gives the
 * isolated engine frame only the book bytes and saved position, and relays
 * the engine's positions to the application with this session's identity.
 */
export function CatalogReader({
  title,
  onOpenLibrary,
  onQuit,
}: {
  title: string;
  onOpenLibrary(): void;
  onQuit(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [book, setBook] = useState<OpenedBook | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [replace, setReplace] = useState(false);
  const ready = useRef(false);
  const [crashed, setCrashed] = useState(false);
  const failed = useRef(false);
  const draining = useRef<string | null>(null);
  const [reported, setReported] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ sequence: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly requests a new session and engine.
  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    failed.current = false;
    setCrashed(false);
    setBook(null);
    setSaved(null);
    setReported(0);
    setSaveError(null);
    setAlert(null);
    setNotice(null);
    window.borges.reader
      .openBook()
      .then((opened) => {
        if (!cancelled) setBook(opened);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setAlert(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const stopCrash = window.borges.reader.onEngineGone(() => {
      failed.current = true;
      ready.current = false;
      setCrashed(true);
      setAlert(
        "The book process stopped. Retry reader reopens the last saved position. Commands still in flight may be lost.",
      );
      if (draining.current) window.borges.reader.drained(draining.current);
    });
    const stopDrain = window.borges.reader.onDrain((token) => {
      draining.current = token;
      if (!ready.current) window.borges.reader.drained(token);
      else
        frame.current?.contentWindow?.postMessage(
          { type: "borges:drain", token },
          new URL(frame.current?.src ?? "about:blank").origin,
        );
    });
    const stopResume = window.borges.reader.onResume(() => {
      draining.current = null;
      frame.current?.contentWindow?.postMessage(
        { type: "borges:resume" },
        new URL(frame.current?.src ?? "about:blank").origin,
      );
    });
    return () => {
      stopCrash();
      stopDrain();
      stopResume();
    };
  }, []);

  const retrySaving = () => {
    window.borges.reader
      .flush()
      .catch((reason: unknown) =>
        setSaveError(
          `Position not saved: ${String(reason)} Check available disk space and library permissions, then retry saving.`,
        ),
      );
  };

  useEffect(() => {
    if (!book) return;
    let sequence = 0;
    let delivered = false;
    const onMessage = (event: MessageEvent) => {
      const engine = frame.current?.contentWindow;
      // Only the assigned engine document; never its chapter frames.
      if (
        failed.current ||
        !engine ||
        event.source !== engine ||
        event.origin !== new URL(frame.current?.src ?? "about:blank").origin
      )
        return;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (data.type === "borges:ready" && !delivered) {
        delivered = true;
        const bytes = book.bytes.slice().buffer;
        engine.postMessage(
          {
            type: "borges:open",
            fileName: book.fileName,
            format: book.format,
            bytes,
            location: book.location,
            sizing: book.sizing,
          },
          new URL(frame.current?.src ?? "about:blank").origin,
          [bytes],
        );
      } else if (data.type === "borges:opened") {
        ready.current = true;
        setNotice(restorationNotices[String(data.restoration)] ?? null);
        window.borges.reader
          .bookOpened(book.bookId, book.generation)
          .catch((reason: unknown) => setAlert(String(reason)));
      } else if (
        data.type === "borges:drained" &&
        data.token === draining.current
      ) {
        window.borges.reader.drained(String(data.token));
      } else if (data.type === "borges:error") {
        setAlert(`Reader operation failed: ${String(data.message)}`);
      } else if (data.type === "borges:failed") {
        ready.current = false;
        setAlert(`This book could not be opened: ${String(data.message)}`);
      } else if (data.type === "borges:position") {
        sequence += 1;
        setReported(sequence);
        window.borges.reader.reportProgress({
          bookId: book.bookId,
          revisionId: book.revisionId,
          generation: book.generation,
          sequence,
          location: data.location as never,
          sizing: data.sizing as never,
        });
      }
    };
    window.addEventListener("message", onMessage);
    const unsubscribe = window.borges.reader.onProgressResult((result) => {
      if (result.generation !== book.generation) return;
      if (result.ok) {
        setSaved({ sequence: result.sequence });
        setSaveError(null);
      } else {
        setSaveError(
          `Position not saved: ${result.message} Check available disk space and library permissions, then retry saving.`,
        );
      }
    });
    return () => {
      window.removeEventListener("message", onMessage);
      unsubscribe();
    };
  }, [book]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.metaKey ||
        (event.target instanceof Element && event.target.closest("dialog"))
      )
        return;
      const action =
        event.key === "F9"
          ? "controls"
          : event.ctrlKey && ["+", "=", "-"].includes(event.key)
            ? event.key === "-"
              ? "smaller"
              : "larger"
            : null;
      if (!action || !ready.current || draining.current) return;
      event.preventDefault();
      frame.current?.contentWindow?.postMessage(
        { type: "borges:shortcut", action },
        new URL(frame.current.src).origin,
      );
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  return (
    <div className="reader-window">
      <header className="reader-title">
        <h1>{book?.title ?? title}</h1>
        <p
          data-testid="save-status"
          data-sequence={saved?.sequence ?? 0}
          hidden
          data-state={
            saveError
              ? "error"
              : reported > (saved?.sequence ?? 0)
                ? "pending"
                : saved
                  ? "saved"
                  : "initial"
          }
        />
        <span className="reader-window-actions">
          {book && saveError ? (
            <button type="button" onClick={retrySaving}>
              Retry saving
            </button>
          ) : null}
          <button type="button" onClick={onOpenLibrary}>
            Open library
          </button>
          <button type="button" onClick={onQuit}>
            Quit application
          </button>
        </span>
      </header>
      {/* Messages float over the page: resizing the book frame would
          repaginate it and report a new position. */}
      <div className="reader-stage">
        <ReaderLinks frame={frame} />
        <div className="reader-messages">
          {saveError ? <p role="alert">{saveError}</p> : null}
          {alert ? (
            <div className="reader-error" role="alert">
              <p>{alert}</p>
              <div>
                <button
                  type="button"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry reader
                </button>
                <button type="button" onClick={() => setReplace(true)}>
                  Replace file…
                </button>
                <button type="button" onClick={onOpenLibrary}>
                  Open library
                </button>
              </div>
            </div>
          ) : null}
          {notice ? <p data-testid="restoration-notice">{notice}</p> : null}
        </div>
        {book && !crashed ? (
          <iframe
            key={book.generation}
            ref={frame}
            title="Book content"
            src={engineUrl({
              id: book.bookId,
              title: book.title,
              source: "catalog",
            })}
            sandbox="allow-scripts allow-same-origin"
          />
        ) : null}
      </div>
      {replace ? (
        <ReplaceFileDialog
          book={{ title: book?.title ?? title }}
          onClose={() => setReplace(false)}
          onReplace={() => {
            setReplace(false);
            window.borges.reader
              .replaceFile()
              .then((result) => {
                if (!result.ok) setAlert(result.message);
                else if (result.value?.warnings.length)
                  setAlert(`File replaced. ${result.value.warnings.join(" ")}`);
              })
              .catch((reason: unknown) => setAlert(String(reason)));
          }}
        />
      ) : null}
    </div>
  );
}
