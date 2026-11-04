// Shared library-service rules: typed errors, input validation and the one
// case-insensitive key used for section names, subject labels and search.

export type LibraryErrorCode =
  | "invalid"
  | "unknown-book"
  | "unknown-section"
  | "name-conflict"
  | "section-cycle"
  | "storage-failed";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
  }
}

/**
 * Comparison key: Unicode compatibility normalization, case folding, trimmed
 * with repeated whitespace collapsed. Stored `name_key`/`label_key` columns
 * hold this value, so changing it requires a migration that rewrites them.
 */
export function foldKey(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, " ");
}

/** Whitespace-separated, case-folded search terms; empty for blank input. */
export function searchTerms(text: string): string[] {
  return foldKey(text).split(" ").filter(Boolean);
}

export const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

const MAX_TEXT = 1000;
// Metadata lists are short; ID lists cover a "select all" in a large library.
const MAX_ITEMS = 500;
const MAX_IDS = 100_000;

export function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64)
    throw new LibraryError("invalid", `A valid ${what} ID is required.`);
  return value;
}

export function requireIds(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS)
    throw new LibraryError("invalid", `A list of ${what} IDs is required.`);
  return [...new Set(value.map((item) => requireId(item, what)))];
}

/** A trimmed, nonempty display name (titles, section names). */
export function requireName(value: unknown, what: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "")
    throw new LibraryError("invalid", `${what} cannot be empty.`);
  if (name.length > MAX_TEXT)
    throw new LibraryError("invalid", `${what} is too long.`);
  return name;
}

/** Trimmed nonempty entries of an untrusted string list, in order. */
export function cleanList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS)
    throw new LibraryError("invalid", `${what} must be a list of names.`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > MAX_TEXT)
      throw new LibraryError("invalid", `${what} must be a list of names.`);
    const trimmed = item.trim();
    if (trimmed !== "") items.push(trimmed);
  }
  return items;
}

/**
 * Report SQLite failures distinctly. Writers run inside one transaction, so
 * a failure means nothing was committed.
 */
export function storage<T>(work: () => T, kind: "read" | "write"): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new LibraryError(
      "storage-failed",
      kind === "read"
        ? `The library could not be read (${reason}).`
        : `The library could not be updated (${reason}). Nothing was changed.`,
    );
  }
}
