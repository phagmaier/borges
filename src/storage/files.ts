import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// Managed-file primitives for the operation protocol. All I/O is async so
// copying and hashing never block the main event loop; durability uses fsync
// on the file and on each directory whose entries change.

export interface FileDigest {
  sha256: string;
  size: number;
}

const CHUNK = 256 * 1024;

/**
 * Copy an open source into a new file at `target` while hashing what was
 * written, then fsync it. `target` must not exist. `afterChunk` runs after
 * each chunk is written (failure injection and cancellation hook).
 */
export async function copyToNewFile(
  source: FileHandle,
  target: string,
  afterChunk: () => void = () => {},
): Promise<FileDigest> {
  const hash = createHash("sha256");
  const output = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o644,
  );
  let size = 0;
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, CHUNK, size);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      await writeAll(output, chunk);
      hash.update(chunk);
      size += bytesRead;
      afterChunk();
    }
    await output.sync();
  } finally {
    await output.close();
  }
  return { sha256: hash.digest("hex"), size };
}

async function writeAll(output: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await output.write(chunk, offset);
    offset += bytesWritten;
  }
}

/** Hash an existing regular file without following a final symlink. */
export async function digestFile(path: string): Promise<FileDigest> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, size);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

/** What is at a managed path, without following symlinks. */
export async function entryKind(
  path: string,
): Promise<"missing" | "file" | "other"> {
  try {
    return (await lstat(path)).isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Move complete bytes to their immutable final path on the same filesystem
 * and make both directory entries durable. Refuses to replace anything.
 */
export async function publishFile(staged: string, target: string) {
  if ((await entryKind(target)) !== "missing") {
    throw new Error(`Refusing to overwrite existing managed file ${target}.`);
  }
  await rename(staged, target);
  await syncDirectory(dirname(target));
  await syncDirectory(dirname(staged));
}

/** Remove one managed file and make the removal durable. */
export async function removeFile(path: string): Promise<void> {
  await unlink(path);
  await syncDirectory(dirname(path));
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
