// Real child process for lock and crash tests; run directly by Node.
import { mkdirSync } from "node:fs";
import { setManualCover } from "../../src/library/covers.ts";
import { addFileAsNewBook, type ImportStep } from "../../src/library/import.ts";
import {
  beginReaderSession,
  saveProgress,
} from "../../src/library/progress.ts";
import { openLibrary } from "../../src/storage/catalog.ts";
import { acquireRootLock } from "../../src/storage/lock.ts";
import { catalogMigrations } from "../../src/storage/schema.ts";

const [mode, root, ...extra] = process.argv.slice(2);
if (!root) throw new Error("usage: storage-child.ts <mode> <root>");
const block = () =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

if (mode === "hold-lock") {
  mkdirSync(root, { recursive: true });
  acquireRootLock(root);
  console.log("locked");
  block();
} else if (mode === "crash-during-upgrade") {
  openLibrary({
    root,
    migrations: [
      // A schema-1 build's runner with a synthetic interrupted version 2.
      ...catalogMigrations.slice(0, 1),
      {
        version: 2,
        description: "Interrupted upgrade",
        up(database) {
          // Force dirty pages out of the cache into the WAL before the kill.
          database.exec("PRAGMA cache_size = 4");
          database.exec(`
            CREATE TABLE padding (value TEXT NOT NULL) STRICT;
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
            INSERT INTO padding SELECT printf('%0200d', i) FROM n;
            UPDATE books SET title = 'CHANGED BY INTERRUPTED UPGRADE';
          `);
          console.log("migrating");
          block();
        },
      },
    ],
  });
} else if (mode === "save-then-hang") {
  // Commit three acknowledged positions for book b1, then stop responding.
  const { database } = openLibrary({ root });
  const { bookId, revisionId, generation } = beginReaderSession(database, "b1");
  for (const sequence of [1, 2, 3]) {
    const ack = saveProgress(database, {
      bookId,
      revisionId,
      generation,
      sequence,
      location: { format: "pdf", page: sequence * 10, x: 0, y: 0.5 },
      sizing: { fontSize: 16, zoom: 1.5 },
    });
    console.log(`acked ${ack.sequence}`);
  }
  block();
} else if (mode === "cover-and-stop") {
  const [source, step] = extra as [string, ImportStep];
  const library = openLibrary({ root });
  await setManualCover(library, "b1", source, {
    // Storage/crash checks isolate the decoder, exercised by native tests.
    normalize: (bytes) => bytes,
    checkpoint(reached) {
      if (reached !== step) return;
      console.log(`at ${step}`);
      block();
    },
  });
  throw new Error(`never reached ${step}`);
} else if (mode === "import-and-stop") {
  // Add `source` as a new book and hang at protocol point `step`.
  const [source, step] = extra as [string, ImportStep];
  const library = openLibrary({ root });
  await addFileAsNewBook(library, source, {
    checkpoint(reached) {
      if (reached !== step) return;
      console.log(`at ${step}`);
      block();
    },
  });
  throw new Error(`never reached ${step}`);
} else if (mode === "add-books") {
  // Add each source as a new book, print {title: bookId}, and exit.
  const library = openLibrary({ root });
  const added: Record<string, string> = {};
  for (const source of extra) {
    const book = await addFileAsNewBook(library, source);
    added[book.title] = book.bookId;
  }
  library.close();
  console.log(JSON.stringify(added));
} else {
  throw new Error(`unknown mode ${mode}`);
}
