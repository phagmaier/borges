import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type {
  LibraryResult,
  SectionDeletion,
  SectionNode,
} from "../../../shared/runtime";
import { branchIds, flattenSections } from "./views";

type Outcome = Promise<LibraryResult<unknown>>;

/**
 * A one-field form that reports the service's explanation (for example a
 * sibling-name conflict) without losing what was typed.
 */
function NameForm({
  label,
  submitLabel,
  initial = "",
  onSubmit,
  onDone,
}: {
  label: string;
  submitLabel: string;
  initial?: string;
  onSubmit(name: string): Outcome;
  onDone(): void;
}) {
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await onSubmit(name);
    if (result.ok) onDone();
    else setProblem(result.message);
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <label>
        <span>{label}</span>
        <input
          ref={field}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onDone();
          }}
        />
      </label>
      <button type="submit">{submitLabel}</button>
      <button type="button" onClick={onDone}>
        Cancel
      </button>
      {problem ? <p role="alert">{problem}</p> : null}
    </form>
  );
}

/** Root-section creation, offered under the sidebar's Sections heading. */
export function NewRootSection({ onCreated }: { onCreated(id: string): void }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="new-section"
        onClick={() => setOpen(true)}
      >
        New section
      </button>
    );
  return (
    <NameForm
      label="New section name"
      submitLabel="Create"
      onSubmit={async (name) => {
        const result = await window.borges.library.createSection(name, null);
        if (result.ok) onCreated(result.value.id);
        return result;
      }}
      onDone={() => setOpen(false)}
    />
  );
}

type Panel = "subsection" | "rename" | "move" | null;

/**
 * Actions for the selected section: a subsection, rename, move within the
 * tree (never into its own branch), and deletion after a confirmation that
 * states what will be removed. Books are never deleted.
 */
export function SectionActions({
  section,
  sections,
  onCreated,
}: {
  section: SectionNode;
  sections: SectionNode[];
  onCreated(id: string): void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [deletion, setDeletion] = useState<SectionDeletion | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();

  // A different section closes any open form.
  useEffect(() => {
    void section.id;
    setPanel(null);
    setProblem(null);
  }, [section.id]);

  async function askToDelete() {
    setProblem(null);
    const preview = await window.borges.library.previewSectionDeletion(
      section.id,
    );
    if (!preview.ok) {
      setProblem(preview.message);
      return;
    }
    setDeletion(preview.value);
    dialog.current?.showModal();
  }

  async function confirmDelete() {
    const result = await window.borges.library.deleteSection(section.id);
    dialog.current?.close();
    // On success the window falls back to All Books when it refreshes.
    if (!result.ok) setProblem(result.message);
  }

  const excluded = new Set(branchIds(section));
  const destinations = flattenSections(sections).filter(
    (entry) => !excluded.has(entry.id),
  );
  const subsections = deletion ? deletion.sections - 1 : 0;
  const books = (count: number) => `${count} ${count === 1 ? "book" : "books"}`;

  return (
    <div className="section-actions">
      <div className="actions">
        <button type="button" onClick={() => setPanel("subsection")}>
          New subsection
        </button>
        <button type="button" onClick={() => setPanel("rename")}>
          Rename section
        </button>
        <button type="button" onClick={() => setPanel("move")}>
          Move section
        </button>
        <button type="button" onClick={askToDelete}>
          Delete section
        </button>
      </div>
      {panel === "subsection" ? (
        <NameForm
          label={`New subsection of ${section.name}`}
          submitLabel="Create"
          onSubmit={async (name) => {
            const result = await window.borges.library.createSection(
              name,
              section.id,
            );
            if (result.ok) onCreated(result.value.id);
            return result;
          }}
          onDone={() => setPanel(null)}
        />
      ) : panel === "rename" ? (
        <NameForm
          label="Section name"
          submitLabel="Rename"
          initial={section.name}
          onSubmit={(name) =>
            window.borges.library.renameSection(section.id, name)
          }
          onDone={() => setPanel(null)}
        />
      ) : panel === "move" ? (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("parent");
            const result = await window.borges.library.moveSection(
              section.id,
              value === "" ? null : String(value),
            );
            if (result.ok) setPanel(null);
            else setProblem(result.message);
          }}
        >
          <label>
            <span>Move {section.name} into</span>
            <select name="parent" defaultValue={section.parentId ?? ""}>
              <option value="">Top level</option>
              {destinations.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.path}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Move</button>
          <button type="button" onClick={() => setPanel(null)}>
            Cancel
          </button>
        </form>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <dialog ref={dialog} aria-labelledby={`${ids}-delete`}>
        <h2 id={`${ids}-delete`}>Delete {section.name}?</h2>
        {deletion ? (
          <p>
            {subsections > 0
              ? `This also deletes ${subsections} ${subsections === 1 ? "subsection" : "subsections"}. `
              : ""}
            {books(deletion.books)} will lose{" "}
            {deletion.books === 1 ? "its membership" : "their memberships"} here
            {deletion.unfiled > 0
              ? `; ${books(deletion.unfiled)} will become Unfiled`
              : ""}
            . No book is deleted.
          </p>
        ) : null}
        <div className="actions">
          <button type="button" onClick={confirmDelete}>
            Delete
          </button>
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </div>
  );
}
