import { useEffect, useRef } from "react";
import type { BookSummary } from "../../../shared/runtime";

export function ReplaceFileDialog({
  book,
  onClose,
  onReplace,
}: {
  book: Pick<BookSummary, "title">;
  onClose(): void;
  onReplace(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="replace-file-dialog"
      aria-labelledby="replace-file-title"
      onCancel={onClose}
    >
      <h2 id="replace-file-title">Replace file for {book.title}?</h2>
      <p>
        Choose a PDF or EPUB. Its reading position starts at the beginning; an
        open reader restarts.
      </p>
      <p>
        Your sections, reading status, Archive flag and manual details are kept.
        The previous file and saved position stay in Trash until you empty it.
        The source files stay untouched.
      </p>
      <div className="actions">
        <button type="button" onClick={onReplace}>
          Choose replacement…
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
