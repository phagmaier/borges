import { useCallback, useEffect, useState } from "react";
import type {
  ImportOutcome,
  ImportOutcomeKind,
  ImportProgress,
  ImportSummary,
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
          setState({ phase: "idle" });
          onError(String(reason));
        });
    },
    [onError],
  );

  const cancel = useCallback(() => {
    setState((current) =>
      current.phase === "running" ? { ...current, cancelling: true } : current,
    );
    void window.borges.library.cancelImport();
  }, []);

  const dismiss = useCallback(() => setState({ phase: "idle" }), []);
  return { state, start, cancel, dismiss };
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
    (outcome) => outcome.kind === "imported",
  );
  return (
    <section className="import-panel" aria-label="Import summary">
      <h2>{summary.cancelled ? "Import cancelled" : "Import finished"}</h2>
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
