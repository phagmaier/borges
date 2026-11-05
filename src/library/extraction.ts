import type { BookFormat } from "./formats.ts";

/** Parsed content and optional extraction, produced outside main. A failure
 * to validate is fatal; optional extraction failures become warnings. */
export interface ExtractedBook {
  title: string | null;
  authors: string[];
  subjects: string[];
  /** A bounded, decoded raster PNG thumbnail. */
  cover: Uint8Array | null;
  warnings: string[];
}

export type InspectBook = (
  stagedPath: string,
  format: BookFormat,
  signal?: AbortSignal,
) => Promise<ExtractedBook>;

export class InspectionError extends Error {
  readonly code:
    | "protected"
    | "invalid-content"
    | "resource-limit"
    | "cancelled";
  constructor(
    code: "protected" | "invalid-content" | "resource-limit" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "InspectionError";
    this.code = code;
  }
}
