import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { DuplicateChoice, DuplicatePrompt } from "./duplicates.ts";
import type { InspectBook } from "./extraction.ts";
import { formatFromName } from "./formats.ts";
import {
  addFileAsNewBook,
  type ExistingBook,
  ImportError,
  type ImportStep,
} from "./import.ts";
import { getBook } from "./query.ts";
import type { LibraryHandle } from "./recovery.ts";
import { restoreRevision } from "./revision-restore.ts";
import { collator, LibraryError } from "./rules.ts";
import { RestoreConflict, restoreDeletedBook } from "./trash.ts";
import type { TrashChoice, TrashMatchPrompt } from "./trash-matches.ts";

// Batch import of selected files and folders (spec, Import and duplicates).
// Folders are walked first: ordinary subdirectories recurse, directory
// symlinks are not followed, the library's own folder is never scanned, and
// each resolved file is imported at most once. Files are then imported one
// at a time through the publication path, each succeeding or failing on its
// own. Cancellation keeps completed books, rolls back the current copy and
// marks the remaining files cancelled.

export type ImportOutcomeKind =
  | "restored"
  | "imported"
  | "skipped"
  | "unsupported"
  | "failed"
  | "cancelled";

export interface ImportOutcome {
  /** File or folder as shown to the user: relative to the selected folder's
   * parent, or the file name for a selected file. */
  name: string;
  kind: ImportOutcomeKind;
  message: string;
  /** Nonfatal results that still need to be shown after an otherwise successful batch. */
  warnings?: string[];
  /** The new book, for imported files. */
  bookId?: string;
  /** A replacement keeps target memberships rather than joining the import section. */
  replaced?: boolean;
  /** The live book with identical content, for skipped duplicates. */
  existing?: ExistingBook;
}

export interface ImportSummary {
  outcomes: ImportOutcome[];
  /** The batch was cancelled before every file was attempted. */
  cancelled: boolean;
}

export interface ImportProgress {
  /** Files attempted so far, of `total` importable candidates. */
  completed: number;
  total: number;
  /** The file being copied, or null when the batch has finished. */
  current: string | null;
}

export interface ImportBatchOptions {
  inspect?: InspectBook;
  onRestoreConflict?: (bookId: string) => Promise<void>;
  chooseTrash?: (prompt: TrashMatchPrompt) => Promise<TrashChoice>;
  chooseDuplicate?: (prompt: DuplicatePrompt) => Promise<DuplicateChoice>;
  beforeReplacement?: (bookId: string) => void | Promise<void>;
  afterReplacement?: (bookId: string) => Promise<string | null>;
  /** Imported books join this section; null or absent means Unfiled. */
  sectionId?: string | null;
  signal?: AbortSignal;
  onProgress?(progress: ImportProgress): void;
  /** Called after each committed book, so views can refresh during a batch. */
  onImported?(bookId: string): void;
  /** Failure-injection hook: the file's protocol points (see import.ts). */
  checkpoint?(name: string, step: ImportStep): void;
  /** Awaited after each copied chunk; see `AddBookOptions.pace`. */
  pace?: () => Promise<void>;
}

type Entry =
  | { kind: "file"; name: string; path: string }
  | { kind: "outcome"; outcome: ImportOutcome };

/**
 * Import the selected absolute paths. Throws only for an invalid request
 * (bad input list or unknown target section); every per-file problem is an
 * outcome in the summary.
 */
export async function importBatch(
  library: LibraryHandle,
  inputs: unknown,
  options: ImportBatchOptions = {},
): Promise<ImportSummary> {
  const paths = validateInputs(inputs);
  const sectionId = options.sectionId ?? null;
  if (sectionId !== null) {
    if (typeof sectionId !== "string")
      throw new LibraryError("invalid", "The target section is invalid.");
    if (
      !library.database
        .prepare("SELECT 1 FROM sections WHERE id = ?")
        .get(sectionId)
    )
      throw new LibraryError(
        "unknown-section",
        "The section to import into no longer exists.",
      );
  }
  const { signal } = options;
  const entries = await collectEntries(library.root, paths);
  const total = entries.filter((entry) => entry.kind === "file").length;
  const outcomes: ImportOutcome[] = [];
  let completed = 0;
  let cancelled = false;
  for (const entry of entries) {
    if (entry.kind === "outcome") {
      outcomes.push(entry.outcome);
      continue;
    }
    if (signal?.aborted) {
      cancelled = true;
      outcomes.push({
        name: entry.name,
        kind: "cancelled",
        message: "Not imported: the import was cancelled before this file.",
      });
      continue;
    }
    options.onProgress?.({ completed, total, current: entry.name });
    outcomes.push(await importOne(library, entry, sectionId, options));
    if (outcomes.at(-1)?.kind === "cancelled") cancelled = true;
    completed++;
  }
  options.onProgress?.({ completed, total, current: null });
  return { outcomes, cancelled };
}

async function importOne(
  library: LibraryHandle,
  entry: { name: string; path: string },
  sectionId: string | null,
  {
    signal,
    onImported,
    checkpoint,
    pace,
    inspect,
    chooseDuplicate,
    chooseTrash,
    onRestoreConflict,
    beforeReplacement,
    afterReplacement,
  }: ImportBatchOptions,
): Promise<ImportOutcome> {
  const { name } = entry;
  let quiesced: string | null = null;
  let outcome: ImportOutcome | undefined;
  try {
    const added = await addFileAsNewBook(library, entry.path, {
      sectionId,
      ...(chooseTrash ? { chooseTrash } : {}),
      async restoreTrash(candidate, mode) {
        try {
          if (mode === "book") {
            const restored = await restoreDeletedBook(
              library,
              candidate.entryId,
              undefined,
              signal,
            );
            return {
              bookId: restored.bookId,
              title: getBook(library.database, restored.bookId).title,
              warnings: [
                ...restored.warnings,
                ...(restored.missingSections.length
                  ? [
                      `Sections no longer available: ${restored.missingSections.join(", ")}.`,
                    ]
                  : []),
                ...(restored.archived ? ["The book remains archived."] : []),
              ],
            };
          }
          return await restoreRevision(library, candidate.entryId, mode, {
            ...(signal ? { signal } : {}),
            expectedCurrentId: candidate.currentRevisionId,
            async beforeCommit(bookId) {
              await beforeReplacement?.(bookId);
              quiesced = bookId;
            },
          });
        } catch (error) {
          if (error instanceof RestoreConflict)
            await onRestoreConflict?.(error.bookId);
          throw error;
        }
      },
      ...(chooseDuplicate ? { chooseDuplicate } : {}),
      async beforeReplacement(bookId) {
        await beforeReplacement?.(bookId);
        quiesced = bookId;
      },
      ...(inspect ? { inspect } : {}),
      ...(signal ? { signal } : {}),
      ...(checkpoint ? { checkpoint: (step) => checkpoint(name, step) } : {}),
      ...(pace ? { pace } : {}),
    });
    onImported?.(added.bookId);
    const sectionMissing =
      sectionId !== null && !added.replaced && !added.joinedSection;
    const warnings = [...added.warnings];
    if (sectionMissing)
      warnings.push(
        "The target section was deleted during import; the book is in Unfiled.",
      );
    outcome = {
      name,
      kind: "imported",
      bookId: added.bookId,
      ...(added.replaced ? { replaced: true } : {}),
      ...(warnings.length ? { warnings } : {}),
      message:
        (added.replaced
          ? `Replaced file for “${added.title}”; previous file and position kept in Trash.`
          : sectionMissing
            ? `Imported as “${added.title}” into Unfiled: the target section was deleted during the import.`
            : `Imported as “${added.title}”.`) +
        added.warnings.map((warning) => ` Warning: ${warning}`).join(""),
    };
    return outcome;
  } catch (error) {
    if (!(error instanceof ImportError))
      return { name, kind: "failed", message: errorText(error) };
    switch (error.code) {
      case "restored":
        if (error.restored) onImported?.(error.restored.bookId);
        outcome = {
          name,
          kind: "restored",
          message: error.message,
          ...(error.restored?.warnings.length
            ? { warnings: error.restored.warnings }
            : {}),
          ...(error.restored ? { bookId: error.restored.bookId } : {}),
        };
        return outcome;
      case "skipped":
      case "duplicate":
        return {
          name,
          kind: "skipped",
          message: error.message,
          ...(error.existing ? { existing: error.existing } : {}),
        };
      case "cancelled":
        return {
          name,
          kind: "cancelled",
          message: `Cancelled during import; no book was created for ${name}.`,
        };
      case "unsupported":
      case "mismatched":
      case "protected":
      case "resource-limit":
        return { name, kind: "unsupported", message: error.message };
      default:
        return { name, kind: "failed", message: error.message };
    }
  } finally {
    if (quiesced && afterReplacement) {
      const warning = await afterReplacement(quiesced);
      if (warning && outcome) {
        outcome.message += ` Warning: ${warning}`;
        outcome.warnings = [...(outcome.warnings ?? []), warning];
      }
    }
  }
}

function validateInputs(inputs: unknown): string[] {
  if (
    !Array.isArray(inputs) ||
    inputs.length === 0 ||
    !inputs.every(
      (path) =>
        typeof path === "string" && isAbsolute(path) && !path.includes("\0"),
    )
  )
    throw new LibraryError(
      "invalid",
      "Choose one or more files or folders to import.",
    );
  return inputs as string[];
}

/** Identity of a resolved filesystem object, for once-per-batch checks. */
const identity = (info: { dev: number; ino: number }) =>
  `${info.dev}:${info.ino}`;

/**
 * Expand the selection into importable files and immediate outcomes, in a
 * stable order: inputs as given, folder entries sorted by name, depth first.
 */
async function collectEntries(
  libraryRoot: string,
  inputs: string[],
): Promise<Entry[]> {
  const root = await realpath(libraryRoot);
  const insideLibrary = (resolved: string) => {
    const path = relative(root, resolved);
    return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
  };
  const seenFiles = new Set<string>();
  const seenFolders = new Set<string>();
  const entries: Entry[] = [];
  const outcome = (
    name: string,
    kind: ImportOutcomeKind,
    message: string,
  ): void => {
    entries.push({ kind: "outcome", outcome: { name, kind, message } });
  };

  /** A regular file (possibly reached through a file symlink). */
  const addFile = (
    name: string,
    path: string,
    info: { dev: number; ino: number },
  ) => {
    const key = identity(info);
    if (seenFiles.has(key)) return; // Same file selected twice: once only.
    seenFiles.add(key);
    if (!formatFromName(basename(path)))
      outcome(name, "unsupported", `${name} is not a PDF or EPUB file.`);
    else entries.push({ kind: "file", name, path });
  };

  const walk = async (folder: string, display: string) => {
    // Iterative depth-first walk; `stack` holds folders still to read.
    const stack: { path: string; name: string }[] = [
      { path: folder, name: display },
    ];
    while (stack.length > 0) {
      const current = stack.pop() as { path: string; name: string };
      let children: Dirent[];
      try {
        children = await readdir(current.path, { withFileTypes: true });
      } catch (error) {
        outcome(
          current.name,
          "failed",
          `The folder ${current.name} could not be read (${errorText(error)}).`,
        );
        continue;
      }
      children.sort((a, b) => collator.compare(a.name, b.name));
      const folders: { path: string; name: string }[] = [];
      for (const child of children) {
        const path = join(current.path, child.name);
        const name = `${current.name}/${child.name}`;
        try {
          const info = await lstat(path);
          if (info.isDirectory()) {
            const key = identity(info);
            if (seenFolders.has(key)) continue;
            seenFolders.add(key);
            if (insideLibrary(await realpath(path)))
              outcome(
                name,
                "skipped",
                `${name} is the Borges library folder; it was not scanned.`,
              );
            else folders.push({ path, name });
          } else if (info.isSymbolicLink()) {
            await addLinked(name, path);
          } else if (info.isFile()) {
            addFile(name, path, info);
          } else if (formatFromName(child.name)) {
            outcome(name, "unsupported", `${name} is not a regular file.`);
          }
        } catch (error) {
          outcome(
            name,
            "failed",
            `${name} could not be read (${errorText(error)}).`,
          );
        }
      }
      // Depth first in name order: push in reverse so the first pops first.
      stack.push(...folders.reverse());
    }
  };

  /** A symlink found inside a folder: file targets only. */
  const addLinked = async (name: string, path: string) => {
    let target: Awaited<ReturnType<typeof stat>>;
    try {
      target = await stat(path);
    } catch (error) {
      outcome(
        name,
        "failed",
        `${name} is a symbolic link whose target cannot be read (${errorText(error)}).`,
      );
      return;
    }
    if (target.isDirectory()) {
      outcome(
        name,
        "skipped",
        `${name} is a symbolic link to a folder; linked folders are not followed.`,
      );
    } else if (!target.isFile()) {
      if (formatFromName(basename(path)))
        outcome(name, "unsupported", `${name} is not a regular file.`);
    } else if (insideLibrary(await realpath(path))) {
      outcome(
        name,
        "skipped",
        `${name} links into the Borges library folder; it was not imported.`,
      );
    } else {
      addFile(name, path, target);
    }
  };

  for (const input of inputs) {
    const name = basename(input) || input;
    try {
      // An explicitly selected link is followed (file or folder): the user
      // chose it. Links found while walking a folder are handled above.
      const resolved = await realpath(input);
      const info = await stat(resolved);
      if (insideLibrary(resolved)) {
        outcome(
          name,
          "skipped",
          `${name} is inside the Borges library folder; it was not imported.`,
        );
      } else if (info.isDirectory()) {
        const key = identity(info);
        if (seenFolders.has(key)) continue;
        seenFolders.add(key);
        await walk(input, name);
      } else if (info.isFile()) {
        addFile(name, input, info);
      } else {
        outcome(name, "unsupported", `${name} is not a regular file.`);
      }
    } catch (error) {
      outcome(
        name,
        "failed",
        `${name} could not be read (${errorText(error)}).`,
      );
    }
  }
  return entries;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Counts per outcome kind, for summaries and logs. */
export function countOutcomes(
  summary: ImportSummary,
): Record<ImportOutcomeKind, number> {
  const counts: Record<ImportOutcomeKind, number> = {
    imported: 0,
    restored: 0,
    skipped: 0,
    unsupported: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const outcome of summary.outcomes) counts[outcome.kind]++;
  return counts;
}
