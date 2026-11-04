// Real child process for lock and crash tests; run directly by Node.
import { mkdirSync } from "node:fs";
import { openLibrary } from "../../src/storage/catalog.ts";
import { acquireRootLock } from "../../src/storage/lock.ts";
import { catalogMigrations } from "../../src/storage/schema.ts";

const [mode, root] = process.argv.slice(2);
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
      ...catalogMigrations,
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
} else {
  throw new Error(`unknown mode ${mode}`);
}
