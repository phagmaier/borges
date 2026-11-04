import { useEffect, useRef, useState } from "react";
import type { OpenedBook } from "../../shared/runtime";
import { engineUrl } from "../../shared/windows";

const ENGINE_ORIGIN = "borges://reader";

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
export function CatalogReader() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [book, setBook] = useState<OpenedBook | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ sequence: number; at: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
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
  }, []);

  useEffect(() => {
    if (!book) return;
    let sequence = 0;
    let delivered = false;
    const onMessage = (event: MessageEvent) => {
      const engine = frame.current?.contentWindow;
      // Only the assigned engine document; never its chapter frames.
      if (!engine || event.source !== engine || event.origin !== ENGINE_ORIGIN)
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
          ENGINE_ORIGIN,
          [bytes],
        );
      } else if (data.type === "borges:opened") {
        setNotice(restorationNotices[String(data.restoration)] ?? null);
        window.borges.reader
          .bookOpened(book.bookId, book.generation)
          .catch((reason: unknown) => setAlert(String(reason)));
      } else if (data.type === "borges:failed") {
        setAlert(`This book could not be opened: ${String(data.message)}`);
      } else if (data.type === "borges:position") {
        sequence += 1;
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
        setSaved({ sequence: result.sequence, at: result.savedAt });
        setAlert(null);
      } else {
        setAlert(`Position not saved: ${result.message}`);
      }
    });
    return () => {
      window.removeEventListener("message", onMessage);
      unsubscribe();
    };
  }, [book]);

  return (
    <>
      {alert ? <p role="alert">{alert}</p> : null}
      {notice ? <p data-testid="restoration-notice">{notice}</p> : null}
      <p
        data-testid="save-status"
        data-sequence={saved?.sequence ?? 0}
        aria-live="polite"
      >
        {saved
          ? `Position saved at ${new Date(saved.at).toLocaleTimeString()}`
          : "Position not saved yet"}
      </p>
      {book ? (
        <iframe
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
    </>
  );
}
