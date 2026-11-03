import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordRuntimeLaunch } from "../../src/main/runtime-database";

describe("diagnostic SQLite startup", () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "borges-runtime-db-"));
    path = join(root, "runtime.sqlite");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("initializes once and commits a persistent launch count without replacing data", () => {
    expect(recordRuntimeLaunch(path)).toMatchObject({
      schemaVersion: 1,
      launchCount: 1,
      marker: "Borges SQLite runtime probe",
    });
    const database = new DatabaseSync(path);
    database
      .prepare("UPDATE runtime_probe SET marker = ?")
      .run("A preserved book — 蘭");
    database.close();
    expect(recordRuntimeLaunch(path)).toMatchObject({
      schemaVersion: 1,
      launchCount: 2,
      marker: "A preserved book — 蘭",
    });
    const reopened = new DatabaseSync(path, { readOnly: true });
    try {
      expect(reopened.prepare("PRAGMA user_version").get()?.user_version).toBe(
        1,
      );
      expect(
        reopened.prepare("SELECT launch_count FROM runtime_probe").get()
          ?.launch_count,
      ).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("refuses a newer schema without changing its bytes", () => {
    const database = new DatabaseSync(path);
    database.exec(
      "PRAGMA user_version = 2; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('retain me');",
    );
    database.close();
    const before = readFileSync(path);
    expect(() => recordRuntimeLaunch(path)).toThrow(
      "Unsupported runtime diagnostic schema 2",
    );
    expect(readFileSync(path)).toEqual(before);
  });

  it("refuses an unversioned populated database without claiming or changing it", () => {
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('preserve');",
    );
    database.close();
    const before = readFileSync(path);
    expect(() => recordRuntimeLaunch(path)).toThrow(
      "Unversioned runtime diagnostic database is not empty",
    );
    expect(readFileSync(path)).toEqual(before);
  });

  it("reports a damaged supported schema without silently recreating the probe", () => {
    recordRuntimeLaunch(path);
    const database = new DatabaseSync(path);
    database.exec("DELETE FROM runtime_probe");
    database.close();
    const before = readFileSync(path);
    expect(() => recordRuntimeLaunch(path)).toThrow(
      "Runtime diagnostic record is missing",
    );
    expect(readFileSync(path)).toEqual(before);
  });

  it("rolls back an update that fails after changing a row and permits retry", () => {
    recordRuntimeLaunch(path);
    const database = new DatabaseSync(path);
    // RAISE(FAIL) leaves the statement's earlier row update in the transaction;
    // explicit rollback must preserve the previously committed count.
    database.exec(`CREATE TRIGGER fail_launch AFTER UPDATE ON runtime_probe
      BEGIN SELECT RAISE(FAIL, 'injected write failure'); END;`);
    try {
      expect(() => recordRuntimeLaunch(path)).toThrow("injected write failure");
      expect(
        database.prepare("SELECT launch_count FROM runtime_probe").get()
          ?.launch_count,
      ).toBe(1);
      database.exec("DROP TRIGGER fail_launch");
    } finally {
      database.close();
    }
    expect(recordRuntimeLaunch(path).launchCount).toBe(2);
  });
});
