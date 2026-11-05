import { useEffect, useRef, useState } from "react";
import type { TrashEntry, TrashListing } from "../../../shared/runtime";
import { statusLabels } from "./views";

export function storageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function TrashView() {
  const [listing, setListing] = useState<TrashListing | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revisionChoice, setRevisionChoice] = useState<{
    entry: TrashEntry;
    mode: "current" | "separate";
  } | null>(null);
  const [purgeChoice, setPurgeChoice] = useState<TrashListing | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () => window.borges.library.onChanged(() => setRevision((n) => n + 1)),
    [],
  );
  useEffect(() => {
    void revision;
    let current = true;
    window.borges.library
      .trash()
      .then((result) => {
        if (!current) return;
        if (result.ok) {
          setListing(result.value);
          setLoadError(null);
        } else setLoadError(result.message);
      })
      .catch((reason) => current && setLoadError(String(reason)));
    return () => {
      current = false;
    };
  }, [revision]);
  async function restore(id: string, title: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.borges.library.restoreDeletedBook(id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const restored = result.value;
      setNotice(
        `Restored “${title}”${restored.archived ? " to Archive" : ""}.${restored.missingSections.length ? ` Sections no longer available: ${restored.missingSections.join(", ")}.` : ""}${restored.unfiled ? " The book is in Unfiled." : " Surviving section memberships were kept."}${restored.warnings.length ? ` ${restored.warnings.join(" ")}` : ""}`,
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function purge() {
    if (!purgeChoice) return;
    const snapshot = purgeChoice;
    setPurgeChoice(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.borges.library.emptyTrash(
        snapshot.entries.map((e) => e.id),
        snapshot.bytes,
      );
      if (!result.ok) setError(result.message);
      else {
        setNotice(
          `Permanently removed ${result.value.purged} Trash ${result.value.purged === 1 ? "entry" : "entries"}.`,
        );
        if (result.value.failures.length)
          setError(
            result.value.failures
              .map((f) => `${f.title}: ${f.message}`)
              .join(" "),
          );
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      setRevision((n) => n + 1);
    }
  }
  async function restoreFile() {
    if (!revisionChoice) return;
    const { entry, mode } = revisionChoice;
    setRevisionChoice(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.borges.library.restoreRevision(
        entry.id,
        mode,
        entry.currentRevisionId,
      );
      if (!result.ok) setError(result.message);
      else
        setNotice(
          `${mode === "current" ? "Restored earlier revision for" : "Restored separate Unread book"} “${result.value.title}”.${mode === "current" ? " The displaced file is in Trash; the saved earlier position was recovered." : " The new book starts at the beginning in Unfiled."} ${result.value.warnings.join(" ")}`,
        );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="trash-view" aria-label="Trash contents">
      <p>
        Deleted books and earlier files stay here until you choose to empty
        Trash.
      </p>
      {purgeChoice ? (
        <EmptyTrashDialog
          listing={purgeChoice}
          onClose={() => setPurgeChoice(null)}
          onConfirm={() => void purge()}
        />
      ) : null}
      {revisionChoice ? (
        <RevisionRestoreDialog
          entry={revisionChoice.entry}
          mode={revisionChoice.mode}
          onClose={() => setRevisionChoice(null)}
          onConfirm={() => void restoreFile()}
        />
      ) : null}
      {error || loadError ? <p role="alert">{error ?? loadError}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {listing ? (
        <>
          <p className="trash-storage">
            {listing.entries.length}{" "}
            {listing.entries.length === 1 ? "entry" : "entries"} ·{" "}
            {storageSize(listing.bytes)} in retained files and covers
          </p>
          <button
            type="button"
            disabled={busy || listing.entries.length === 0}
            onClick={() => setPurgeChoice(listing)}
          >
            {busy ? "Working…" : "Empty Trash…"}
          </button>
          {listing.unavailableFiles ? (
            <p role="alert">
              {listing.unavailableFiles} missing or unreadable files are
              excluded from the storage total. Their catalog entries are kept.
            </p>
          ) : null}
          {listing.entries.length === 0 ? (
            <p className="empty">Trash is empty.</p>
          ) : null}
          {(["book", "revision"] as const).map((kind) => {
            const entries = listing.entries.filter(
              (entry) => entry.kind === kind,
            );
            if (!entries.length) return null;
            return (
              <section
                key={kind}
                aria-label={
                  kind === "book" ? "Deleted books" : "Superseded files"
                }
              >
                <h2>
                  {kind === "book" ? "Deleted books" : "Superseded files"}
                </h2>
                <ul className="trash-entries">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <div>
                        <h3>{entry.title}</h3>
                        <p>
                          {entry.fileName} · {entry.format.toUpperCase()} ·{" "}
                          {storageSize(entry.bytes)}
                          {entry.fileProblem
                            ? " · File missing or unreadable"
                            : ""}
                        </p>
                        <p>
                          {kind === "book"
                            ? `${statusLabels[entry.status]}${entry.archived ? " · Archived" : ""} · `
                            : "Saved position: "}
                          {entry.position} · Trashed{" "}
                          {new Date(entry.trashedAt).toLocaleDateString()}
                        </p>
                        {entry.purgeProblem ? (
                          <p role="alert">{entry.purgeProblem}</p>
                        ) : null}
                      </div>
                      {kind === "book" ? (
                        <button
                          type="button"
                          disabled={busy || entry.purging}
                          onClick={() => void restore(entry.id, entry.title)}
                        >
                          Restore book
                        </button>
                      ) : (
                        <div className="actions">
                          <button
                            type="button"
                            disabled={
                              busy || entry.ownerDeleted || entry.purging
                            }
                            title={
                              entry.ownerDeleted
                                ? "Restore the deleted book first"
                                : undefined
                            }
                            onClick={() =>
                              setRevisionChoice({ entry, mode: "current" })
                            }
                          >
                            Restore as current…
                          </button>
                          <button
                            type="button"
                            disabled={busy || entry.purging}
                            onClick={() =>
                              setRevisionChoice({ entry, mode: "separate" })
                            }
                          >
                            Restore as separate book…
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      ) : (
        <p role="status">Loading Trash…</p>
      )}
    </section>
  );
}

function RevisionRestoreDialog({
  entry,
  mode,
  onClose,
  onConfirm,
}: {
  entry: TrashEntry;
  mode: "current" | "separate";
  onClose(): void;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="revision-restore-title"
      onCancel={onClose}
    >
      <h2 id="revision-restore-title">
        {mode === "current"
          ? "Restore earlier revision?"
          : "Restore as a separate Unread book?"}
      </h2>
      <p>
        {entry.title} · {entry.fileName} · {entry.position}
      </p>
      <p>
        {mode === "current"
          ? "Keep current sections, status, Archive and manual details. Recover this file’s saved position and retain the displaced file in Trash. An open reader restarts."
          : "Create an independent copy with extracted details, Unread status, no sections and a position at the beginning. The earlier revision and saved position remain in Trash."}
      </p>
      <div className="actions">
        <button type="button" onClick={onConfirm}>
          Restore
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

function EmptyTrashDialog({
  listing,
  onClose,
  onConfirm,
}: {
  listing: TrashListing;
  onClose(): void;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} aria-labelledby="empty-trash-title" onCancel={onClose}>
      <h2 id="empty-trash-title">Permanently empty Trash?</h2>
      <p>
        {listing.entries.length}{" "}
        {listing.entries.length === 1 ? "entry" : "entries"} ·{" "}
        {storageSize(listing.bytes)} in retained files and covers.
      </p>
      <p>
        This permanently removes deleted books, earlier files and their saved
        positions. Once removal starts they cannot be restored. Source files
        stay untouched. Covers still used by other entries are kept, so freed
        space may be smaller.
      </p>
      {listing.unavailableFiles ? (
        <p>
          Missing or unreadable files are excluded from this total. Uncertain
          files are kept for repair; failed purges remain visible and can be
          retried.
        </p>
      ) : null}
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          Empty Trash permanently
        </button>
      </div>
    </dialog>
  );
}
