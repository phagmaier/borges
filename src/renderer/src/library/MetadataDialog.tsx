import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { BookSummary, MetadataEdit } from "../../../shared/runtime";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
/** Subjects are a set compared ignoring case, as the catalog stores them. */
const sameSet = (a: string[], b: string[]) => {
  const key = (values: string[]) =>
    [...new Set(values.map((value) => value.toLocaleLowerCase()))].sort();
  return same(key(a), key(b));
};

/**
 * Edit one book's title, ordered authors and subjects. Only fields that were
 * changed are sent, so only those become manual overrides; an emptied
 * authors or subjects field is an intentional clear.
 */
export function MetadataDialog({
  book,
  onClose,
  onSaved,
  onRead,
}: {
  book: BookSummary;
  onClose(): void;
  onSaved(book: BookSummary): void;
  onRead?(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(book.title);
  const [authors, setAuthors] = useState(book.authors.join("\n"));
  const [subjects, setSubjects] = useState(book.subjects.join("\n"));
  const [problem, setProblem] = useState<string | null>(null);
  const ids = useId();

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const edit: MetadataEdit = {};
    if (title !== book.title) edit.title = title;
    if (!same(lines(authors), book.authors)) edit.authors = lines(authors);
    if (!sameSet(lines(subjects), book.subjects))
      edit.subjects = lines(subjects);
    if (Object.keys(edit).length === 0) {
      onClose();
      return;
    }
    const result = await window.borges.library.editMetadata(book.id, edit);
    if (result.ok) onSaved(result.value);
    else setProblem(result.message);
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${ids}-title`}
      onClose={onClose}
      className="metadata-dialog"
    >
      <form method="dialog" onSubmit={save}>
        <h2 id={`${ids}-title`}>Edit details</h2>
        <label>
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span>Authors, one per line, in order</span>
          <textarea
            rows={3}
            value={authors}
            onChange={(e) => setAuthors(e.target.value)}
          />
        </label>
        <label>
          <span>Subjects, one per line</span>
          <textarea
            rows={3}
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
          />
        </label>
        {problem ? <p role="alert">{problem}</p> : null}
        <div className="actions">
          {onRead ? (
            <button type="button" onClick={onRead}>
              Read book
            </button>
          ) : null}
          <button type="submit">Save</button>
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
