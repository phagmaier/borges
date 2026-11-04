import { createHash } from "node:crypto";
import { LibraryError } from "./rules.ts";

export const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_DIMENSION = 8192;

/** Read dimensions before decoding so a tiny compressed image cannot claim
 * an unbounded bitmap. Only raster PNG and JPEG are accepted. */
export function inspectCoverImage(bytes: Buffer): {
  width: number;
  height: number;
} {
  if (bytes.length > MAX_COVER_BYTES) throw invalidCover();
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (
        marker === undefined ||
        marker === 0xda ||
        marker === 0xd9 ||
        offset + 2 > bytes.length
      )
        break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += size;
    }
  }
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    throw invalidCover();
  return { width, height };
}

export function invalidCover(): LibraryError {
  return new LibraryError(
    "invalid",
    "Choose a readable PNG or JPEG image up to 10 MiB, 16 megapixels and 8192 pixels per side.",
  );
}

export const coverToken = (path: string) =>
  createHash("sha256").update(path).digest("hex");
