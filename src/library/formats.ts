import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

// Bounded content sniffing for supported book formats. This decides whether
// bytes are plausibly a PDF or an EPUB container; it does not parse the book.
// Parse failures, encryption and metadata are reported by later import work.

export type BookFormat = "pdf" | "epub";

/** The supported format a file name claims, from its final extension. */
export function formatFromName(name: string): BookFormat | null {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return extension === "pdf" || extension === "epub" ? extension : null;
}

/** Display title fallback: the file name without its final extension. */
export function titleFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = (dot <= 0 ? name : name.slice(0, dot)).trim();
  return stem === "" ? name.trim() || "Untitled" : stem;
}

const PDF_HEADER = Buffer.from("%PDF-");
// PDF readers (including PDF.js) accept a header within the first KiB.
const PDF_HEADER_WINDOW = 1024;
const EPUB_MIMETYPE = "application/epub+zip";
const MAX_CENTRAL_DIRECTORY = 32 * 1024 * 1024;
const EOCD_SEARCH = 22 + 0xffff;

/** Identify a regular file's content as PDF, EPUB, or neither. */
export async function sniffFormat(path: string): Promise<BookFormat | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await handle.stat();
    const head = await readAt(handle, 0, Math.min(size, PDF_HEADER_WINDOW));
    if (head.indexOf(PDF_HEADER) >= 0) return "pdf";
    if (head.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))) {
      return (await isEpubContainer(handle, size)) ? "epub" : null;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * An EPUB is a ZIP whose central directory lists `META-INF/container.xml`.
 * A `mimetype` entry, when present, must say `application/epub+zip`, which
 * rejects other OCF-style containers (for example ODF documents).
 */
async function isEpubContainer(
  handle: FileHandle,
  size: number,
): Promise<boolean> {
  const directory = await centralDirectory(handle, size);
  if (!directory) return false;
  let container = false;
  let mimetype: { method: number; compressed: number; local: number } | null =
    null;
  for (let at = 0; at + 46 <= directory.length; ) {
    if (directory.readUInt32LE(at) !== 0x02014b50) return false;
    const nameLength = directory.readUInt16LE(at + 28);
    const next =
      at +
      46 +
      nameLength +
      directory.readUInt16LE(at + 30) +
      directory.readUInt16LE(at + 32);
    if (next > directory.length) return false;
    const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
    if (name === "META-INF/container.xml") container = true;
    if (name === "mimetype") {
      mimetype = {
        method: directory.readUInt16LE(at + 10),
        compressed: directory.readUInt32LE(at + 20),
        local: directory.readUInt32LE(at + 42),
      };
    }
    at = next;
  }
  if (!container) return false;
  if (!mimetype) return true;
  if (mimetype.compressed > 1024) return false;
  const local = await readAt(handle, mimetype.local, 30);
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return false;
  const data = await readAt(
    handle,
    mimetype.local + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
    mimetype.compressed,
  );
  let text: string;
  try {
    if (mimetype.method === 0) text = data.toString("latin1");
    else if (mimetype.method === 8)
      text = inflateRawSync(data, { maxOutputLength: 1024 }).toString();
    else return false;
  } catch {
    return false;
  }
  return text.trim() === EPUB_MIMETYPE;
}

/** The central directory bytes, or null if the ZIP structure is unusable. */
async function centralDirectory(
  handle: FileHandle,
  size: number,
): Promise<Buffer | null> {
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const tail = await readAt(handle, tailStart, size - tailStart);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  let length = tail.readUInt32LE(end + 12);
  let offset = tail.readUInt32LE(end + 16);
  if (length === 0xffffffff || offset === 0xffffffff) {
    // ZIP64: the locator just before the end record points at the real one.
    if (end < 20 || tail.readUInt32LE(end - 20) !== 0x07064b50) return null;
    const record = await readAt(
      handle,
      Number(tail.readBigUInt64LE(end - 12)),
      56,
    );
    if (record.length < 56 || record.readUInt32LE(0) !== 0x06064b50)
      return null;
    length = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
  }
  if (length > MAX_CENTRAL_DIRECTORY || offset + length > size) return null;
  const directory = await readAt(handle, offset, length);
  return directory.length === length ? directory : null;
}

async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length));
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}
