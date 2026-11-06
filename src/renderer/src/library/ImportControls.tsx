import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DuplicateChoice,
  DuplicatePrompt,
  ImportOutcome,
  ImportOutcomeKind,
  ImportProgress,
  ImportSummary,
  TrashChoice,
  TrashMatchPrompt,
} from "../../../shared/runtime";

/** The section imports join, or null for Unfiled. */
export interface ImportTarget {
  id: string;
  name: string;
}

type ImportState =
  | { phase: "idle" }
  | { phase: "choosing" }
  | { phase: "running"; progress: ImportProgress | null; cancelling: boolean }
  | {
      phase: "finished";
      summary: ImportSummary;
      target: ImportTarget | null;
    };

/** Import state for the library window: one batch at a time. */
export function useImport(onError: (message: string) => void) {
  const [trashMatch, setTrashMatch] = useState<
    (TrashMatchPrompt & { token: string }) | null
  >(null);
  useEffect(() => window.borges.library.onImportTrashMatch(setTrashMatch), []);
  const [duplicate, setDuplicate] = useState<
    (DuplicatePrompt & { token: string }) | null
  >(null);
  useEffect(() => window.borges.library.onImportDuplicate(setDuplicate), []);
  const [state, setState] = useState<ImportState>({ phase: "idle" });

  useEffect(
    () =>
      window.borges.library.onImportProgress((progress) =>
        setState((current) =>
          current.phase === "running" || current.phase === "choosing"
            ? {
                phase: "running",
                progress,
                cancelling: current.phase === "running" && current.cancelling,
              }
            : current,
        ),
      ),
    [],
  );

  const start = useCallback(
    (kind: "files" | "folders", target: ImportTarget | null) => {
      setState({ phase: "choosing" });
      window.borges.library
        .importBooks(kind, target?.id ?? null)
        .then((result) => {
          setDuplicate(null);
          setTrashMatch(null);
          if (!result.ok) {
            setState({ phase: "idle" });
            onError(result.message);
          } else if (result.value === null) {
            setState({ phase: "idle" }); // Chooser cancelled.
          } else {
            setState({ phase: "finished", summary: result.value, target });
          }
        })
        .catch((reason: unknown) => {
          setDuplicate(null);
          setTrashMatch(null);
          setState({ phase: "idle" });
          onError(String(reason));
        });
    },
    [onError],
  );

  const cancel = useCallback(() => {
    setDuplicate(null);
    setTrashMatch(null);
    setState((current) =>
      current.phase === "running" ? { ...current, cancelling: true } : current,
    );
    void window.borges.library.cancelImport();
  }, []);

  const dismiss = useCallback(() => setState({ phase: "idle" }), []);
  const choose = async (choice: DuplicateChoice) => {
    if (!duplicate) return;
    const result = await window.borges.library.resolveDuplicate(
      duplicate.token,
      choice,
    );
    if (result.ok)
      setDuplicate((current) =>
        current?.token === duplicate.token ? null : current,
      );
    else onError(result.message);
  };
  const chooseTrash = async (choice: TrashChoice) => {
    if (!trashMatch) return;
    const result = await window.borges.library.resolveTrashMatch(
      trashMatch.token,
      choice,
    );
    if (result.ok)
      setTrashMatch((current) =>
        current?.token === trashMatch.token ? null : current,
      );
    else onError(result.message);
  };
  return {
    state,
    start,
    cancel,
    dismiss,
    duplicate,
    choose,
    trashMatch,
    chooseTrash,
  };
}

export function ImportButtons({
  busy,
  target,
  onStart,
}: {
  busy: boolean;
  target: ImportTarget | null;
  onStart(kind: "files" | "folders"): void;
}) {
  const hint = target
    ? `Imported books join ${target.name}`
    : "Imported books go to Unfiled";
  return (
    <div className="import-buttons">
      <button
        type="button"
        disabled={busy}
        title={hint}
        onClick={() => onStart("files")}
      >
        Import files…
      </button>
      <button
        type="button"
        disabled={busy}
        title={hint}
        onClick={() => onStart("folders")}
      >
        Import folder…
      </button>
    </div>
  );
}

const groupOrder: { kind: ImportOutcomeKind; label: string }[] = [
  { kind: "failed", label: "Failed" },
  { kind: "unsupported", label: "Unsupported" },
  { kind: "skipped", label: "Skipped" },
  { kind: "cancelled", label: "Cancelled" },
  { kind: "imported", label: "Imported" },
  { kind: "restored", label: "Restored/reused" },
];

/** Progress with Cancel while a batch runs; the summary after it ends. */
export function ImportStatus({
  state,
  onCancel,
  onDismiss,
  onShow,
}: {
  state: ImportState;
  onCancel(): void;
  onDismiss(): void;
  onShow(existing: NonNullable<ImportOutcome["existing"]>): void;
}) {
  if (state.phase === "running") {
    const { progress } = state;
    return (
      <section className="import-panel" aria-label="Import">
        <p role="status">
          {state.cancelling
            ? "Cancelling the import…"
            : progress?.current
              ? `Importing ${progress.completed + 1} of ${progress.total}: ${progress.current}`
              : "Preparing the import…"}
        </p>
        <button type="button" disabled={state.cancelling} onClick={onCancel}>
          Cancel import
        </button>
      </section>
    );
  }
  if (state.phase !== "finished") return null;
  const { summary, target } = state;
  const groups = groupOrder
    .map((group) => ({
      ...group,
      outcomes: summary.outcomes.filter(
        (outcome) => outcome.kind === group.kind,
      ),
    }))
    .filter((group) => group.outcomes.length > 0);
  const imported = summary.outcomes.some(
    (outcome) => outcome.kind === "imported" && !outcome.replaced,
  );
  const quiet =
    !summary.cancelled &&
    summary.outcomes.every(
      (outcome) =>
        (outcome.kind === "imported" || outcome.kind === "restored") &&
        !outcome.warnings?.length,
    );
  return (
    <section
      className="import-panel"
      aria-label="Import summary"
      hidden={quiet}
    >
      <h2>
        {summary.cancelled ? "Import cancelled" : "Import needs attention"}
      </h2>
      <p data-testid="import-counts">
        {groups.length === 0
          ? "No files were selected."
          : groups
              .map(
                (group) =>
                  `${group.outcomes.length} ${group.label.toLowerCase()}`,
              )
              .join(" · ")}
      </p>
      {imported ? (
        <p className="quiet">
          {target
            ? `New books joined ${target.name}.`
            : "New books are in Unfiled."}{" "}
          The original files were copied and left unchanged.
        </p>
      ) : null}
      {groups.map((group) => (
        <details
          key={group.kind}
          className={`import-group ${group.kind}`}
          open={group.outcomes.length <= 10}
        >
          <summary>
            {group.label} ({group.outcomes.length})
          </summary>
          <ul aria-label={group.label}>
            {group.outcomes.map((outcome, index) => (
              // Names repeat only for distinct paths with equal display text.
              // biome-ignore lint/suspicious/noArrayIndexKey: outcomes are a fixed list.
              <li key={index}>
                <span className="import-name">{outcome.name}</span>
                {" — "}
                <span className="import-message">{outcome.message}</span>
                {outcome.existing ? (
                  <button
                    type="button"
                    onClick={() => outcome.existing && onShow(outcome.existing)}
                  >
                    Show “{outcome.existing.title}”
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ))}
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

export function ImportDuplicateDialog({
  prompt,
  onChoose,
  onCancel,
}: {
  prompt: DuplicatePrompt;
  onChoose(choice: DuplicateChoice): Promise<void>;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const choose = async (choice: DuplicateChoice) => {
    setBusy(true);
    try {
      await onChoose(choice);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="duplicate-dialog"
      aria-labelledby="duplicate-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="duplicate-title">Similar books in your library</h2>
      <p>
        {prompt.name} — {prompt.title} · {prompt.authors.join(", ")}
      </p>
      <p>
        These entries share the title and an author. Keep Both adds a separate
        book. Choose one entry to replace its file.
      </p>
      <fieldset disabled={busy}>
        <legend>Replacement target</legend>
        {prompt.candidates.map((book) => (
          <label key={book.bookId} className="duplicate-candidate">
            <input
              type="radio"
              name="duplicate-target"
              value={book.bookId}
              checked={target === book.bookId}
              onChange={() => setTarget(book.bookId)}
            />
            {book.title} · {book.authors.join(", ")} ·{" "}
            {book.format.toUpperCase()} · {book.fileName}
            {book.archived ? " (archived)" : ""}
          </label>
        ))}
      </fieldset>
      <p>
        Replacement resets the position and restarts an open reader. Sections,
        status, Archive and manual details are kept. The previous file and
        position stay in Trash.
      </p>
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose({ action: "keep-both" })}
        >
          Keep Both
        </button>
        <button
          type="button"
          disabled={busy || !target}
          onClick={() => void choose({ action: "replace", bookId: target })}
        >
          Replace selected
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose({ action: "skip" })}
        >
          Skip
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel import
        </button>
      </div>
    </dialog>
  );
}

export function ImportTrashDialog({
  prompt,
  onChoose,
  onCancel,
}: {
  prompt: TrashMatchPrompt;
  onChoose(choice: TrashChoice): Promise<void>;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const candidate = prompt.candidates.find((c) => c.entryId === target);
  const choose = async (choice: TrashChoice) => {
    setBusy(true);
    try {
      await onChoose(choice);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="duplicate-dialog"
      aria-labelledby="trash-match-title"
      onCancel={(event) => {
        event.preventDefault();
        void choose({ action: "cancel" });
      }}
    >
      <h2 id="trash-match-title">Identical content in Trash</h2>
      <p>
        {prompt.name} matches retained content. Choose an entry to restore or
        reuse, or cancel this file.
      </p>
      <fieldset disabled={busy}>
        <legend>Matching entries</legend>
        {prompt.candidates.map((c) => (
          <label key={c.entryId} className="duplicate-candidate">
            <input
              type="radio"
              name="trash-match"
              checked={target === c.entryId}
              onChange={() => setTarget(c.entryId)}
            />
            {c.title} · {c.fileName} · {c.format.toUpperCase()} ·{" "}
            {c.kind === "book" ? "Deleted book" : "Earlier revision"}
            {c.ownerDeleted && c.kind === "revision" ? " (book deleted)" : ""}
          </label>
        ))}
      </fieldset>
      <p>
        Restore book keeps its saved state and surviving sections. Restore as
        current keeps the book’s organization and manual details, resumes the
        earlier position and moves its current file to Trash. An open reader
        restarts.
      </p>
      <p>
        A separate book starts Unread at the beginning with extracted details
        and no sections. A copy is made; the retained file and position stay in
        Trash.
      </p>
      <div className="actions">
        <button
          type="button"
          disabled={
            busy ||
            !candidate ||
            (candidate.kind === "revision" && candidate.ownerDeleted)
          }
          onClick={() =>
            candidate &&
            void choose({
              action: "restore",
              entryId: candidate.entryId,
              mode: candidate.kind === "book" ? "book" : "current",
            })
          }
        >
          {candidate?.kind === "revision"
            ? "Restore as current"
            : "Restore book"}
        </button>
        <button
          type="button"
          disabled={busy || !candidate}
          onClick={() =>
            candidate &&
            void choose({
              action: "restore",
              entryId: candidate.entryId,
              mode: "separate",
            })
          }
        >
          Use as separate Unread book
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose({ action: "cancel" })}
        >
          Cancel this file
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel import
        </button>
      </div>
    </dialog>
  );
}
