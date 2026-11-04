import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Insert a live book with its current revision, as one transaction. */
export function addBook(
  database: DatabaseSync,
  {
    book,
    revision,
    title,
    format = "pdf",
  }: { book: string; revision: string; title: string; format?: "pdf" | "epub" },
) {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        "INSERT INTO books (id, current_revision_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      )
      .run(book, revision, title);
    addRevision(database, { book, revision, format });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function addRevision(
  database: DatabaseSync,
  {
    book,
    revision,
    format = "pdf",
  }: { book: string; revision: string; format?: "pdf" | "epub" },
) {
  database
    .prepare(
      "INSERT INTO revisions (id, book_id, format, path, sha256, size, original_filename, created_at) VALUES (?, ?, ?, ?, ?, 3, ?, 1)",
    )
    .run(
      revision,
      book,
      format,
      `files/${revision}.${format}`,
      "a".repeat(64),
      `a.${format}`,
    );
}

const children: ChildProcess[] = [];

/** Run `tests/unit/storage-child.ts` in a real Node process until it prints `ready`. */
export function startChild(
  mode: string,
  root: string,
  ready: string,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [resolve("tests/unit/storage-child.ts"), mode, root],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  let output = "";
  return new Promise((done, fail) => {
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes(ready)) done(child);
    });
    child.on("exit", (code) => fail(new Error(`child exited ${code}`)));
  });
}

export async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
}

export function killChildren() {
  for (const child of children.splice(0)) child.kill("SIGKILL");
}
