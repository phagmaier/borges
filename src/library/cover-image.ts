import { createHash } from "node:crypto";
import { coverDimensions } from "../shared/cover-image.ts";
import { LibraryError } from "./rules.ts";

export { MAX_COVER_BYTES } from "../shared/cover-image.ts";

export function inspectCoverImage(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  const size = coverDimensions(bytes);
  if (!size) throw invalidCover();
  return size;
}

export function invalidCover(): LibraryError {
  return new LibraryError(
    "invalid",
    "Choose a readable PNG or JPEG image up to 10 MiB, 16 megapixels and 8192 pixels per side.",
  );
}

export const coverToken = (path: string) =>
  createHash("sha256").update(path).digest("hex");
