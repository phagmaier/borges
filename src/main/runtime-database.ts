import { DatabaseSync } from "node:sqlite";
import type { RuntimeDatabaseInfo } from "../shared/runtime";

// Deliberately separate from the future library catalog and its migrations.
// No destructive migration is needed for this version-one diagnostic schema.
export function recordRuntimeLaunch(path: string): RuntimeDatabaseInfo {
  const database = new DatabaseSync(path);
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) {
      throw new Error(
        `Unsupported runtime diagnostic schema ${version}; supported: 1.`,
      );
    }
    if (
      version === 0 &&
      database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    ) {
      throw new Error("Unversioned runtime diagnostic database is not empty.");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      if (version === 0) {
        database.exec(`
          CREATE TABLE runtime_probe (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            launch_count INTEGER NOT NULL CHECK (launch_count >= 0),
            marker TEXT NOT NULL
          ) STRICT;
          INSERT INTO runtime_probe VALUES (1, 0, 'Borges SQLite runtime probe');
          PRAGMA user_version = 1;
        `);
      }
      const row = database
        .prepare(
          "UPDATE runtime_probe SET launch_count = launch_count + 1 WHERE id = 1 RETURNING launch_count, marker",
        )
        .get();
      if (!row) throw new Error("Runtime diagnostic record is missing.");
      const sqlite = database
        .prepare("SELECT sqlite_version() AS version")
        .get();
      database.exec("COMMIT");
      return {
        sqlite: String(sqlite?.version),
        schemaVersion: 1,
        launchCount: Number(row.launch_count),
        marker: String(row.marker),
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
