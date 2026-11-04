import { useId, useRef, useState } from "react";
import type {
  BookSummary,
  LibraryResult,
  SectionNode,
} from "../../../shared/runtime";
import { MetadataDialog } from "./MetadataDialog";
import { flattenSections } from "./views";

type StatusAction = "finish" | "archive" | "unarchive" | "startRereading";
const done: Record<StatusAction, string> = {
  finish: "Marked {n} Finished.",
  archive: "Archived {n}.",
  unarchive: "Unarchived {n}.",
  startRereading: "Started rereading {n}.",
};

/**
 * Actions for the selected books. Status and Archive follow the spec's
 * transition table in the service. Sections: add them to any section
 * (keeping their other memberships) or, in a section view, remove this
 * direct membership. None of these deletes a book.
 */
export function SelectionBar({
  selected,
  sections,
  currentSection,
  onClear,
  onMessage,
}: {
  selected: BookSummary[];
  sections: SectionNode[];
  currentSection: SectionNode | undefined;
  onClear(): void;
  onMessage(message: string, problem: boolean): void;
}) {
  const choices = flattenSections(sections);
  const [target, setTarget] = useState("");
  const [editing, setEditing] = useState<BookSummary | null>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const books = (n: number) => `${n} ${n === 1 ? "book" : "books"}`;
  const chosen = choices.find((entry) => entry.id === target);
  const bookIds = selected.map((book) => book.id);
  const count = selected.length;

  async function apply(action: StatusAction, targets: BookSummary[]) {
    const failures: string[] = [];
    for (const book of targets) {
      const result: LibraryResult<unknown> = await window.borges.library[
        action
      ](book.id);
      if (!result.ok) failures.push(`${book.title}: ${result.message}`);
    }
    const succeeded = targets.length - failures.length;
    if (failures.length > 0)
      onMessage(
        `${done[action].replace("{n}", books(succeeded))} Not changed: ${failures.join("; ")}`,
        true,
      );
    else onMessage(done[action].replace("{n}", books(succeeded)), false);
  }

  async function add() {
    if (!chosen) return;
    const result = await window.borges.library.addToSection(chosen.id, bookIds);
    if (result.ok)
      onMessage(
        `Added ${books(result.value.added)} to ${chosen.path}${
          result.value.added < bookIds.length
            ? " (the rest were already there)"
            : ""
        }.`,
        false,
      );
    else onMessage(result.message, true);
  }

  async function remove() {
    if (!currentSection) return;
    const result = await window.borges.library.removeFromSection(
      currentSection.id,
      bookIds,
    );
    if (result.ok)
      onMessage(
        `Removed ${books(result.value.removed)} from ${currentSection.name}.${
          result.value.removed < bookIds.length
            ? " Books listed through a subsection keep that membership."
            : ""
        }`,
        false,
      );
    else onMessage(result.message, true);
  }

  return (
    <section className="selection-bar" aria-label="Selected books">
      <p>{books(count)} selected</p>
      <button
        type="button"
        onClick={() =>
          apply(
            "finish",
            selected.filter((book) => book.status !== "finished"),
          )
        }
      >
        Mark Finished
      </button>
      {selected.some((book) => !book.archived) ? (
        <button
          type="button"
          onClick={() =>
            apply(
              "archive",
              selected.filter((book) => !book.archived),
            )
          }
        >
          Archive
        </button>
      ) : null}
      {selected.some((book) => book.archived) ? (
        <button
          type="button"
          onClick={() =>
            apply(
              "unarchive",
              selected.filter((book) => book.archived),
            )
          }
        >
          Unarchive
        </button>
      ) : null}
      <button type="button" onClick={() => confirm.current?.showModal()}>
        Start Rereading…
      </button>
      {count === 1 && selected[0] ? (
        <button type="button" onClick={() => setEditing(selected[0] ?? null)}>
          Edit details
        </button>
      ) : null}
      {choices.length > 0 ? (
        <>
          <label>
            <span className="sr-only">Section to add to</span>
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">Choose a section…</option>
              {choices.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.path}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!chosen} onClick={add}>
            Add to section
          </button>
        </>
      ) : null}
      {currentSection ? (
        <button type="button" onClick={remove}>
          Remove from {currentSection.name}
        </button>
      ) : null}
      <button type="button" onClick={onClear}>
        Clear selection
      </button>
      <dialog ref={confirm} aria-labelledby={`${ids}-reread`}>
        <h2 id={`${ids}-reread`}>Start rereading {books(count)}?</h2>
        <p>
          Each becomes Currently Reading and returns to the beginning; its saved
          position is cleared and archived books are unarchived. An open reader
          restarts at the beginning.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              confirm.current?.close();
              void apply("startRereading", selected);
            }}
          >
            Start Rereading
          </button>
          <button type="button" onClick={() => confirm.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
      {editing ? (
        <MetadataDialog
          book={editing}
          onClose={() => setEditing(null)}
          onSaved={(book) => {
            setEditing(null);
            onMessage(`Saved details for ${book.title}.`, false);
          }}
        />
      ) : null}
    </section>
  );
}
