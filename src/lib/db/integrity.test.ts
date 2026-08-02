import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, createTestUser } from "@/test/fixture";
import {
  assertDatabaseFingerprintEqual,
  assertDatabaseIntegrity,
  captureDatabaseFingerprint,
} from "@/lib/db/integrity";

const databases: ReturnType<typeof createTestDatabase>[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("database preservation fingerprints", () => {
  it("ignores newly added columns but detects changes to existing canonical values", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { workspace } = createTestUser(database);
    const before = captureDatabaseFingerprint(database);

    database.exec("ALTER TABLE documents ADD COLUMN migration_probe TEXT");
    const afterSchemaOnly = captureDatabaseFingerprint(database, before);
    expect(() => assertDatabaseFingerprintEqual(before, afterSchemaOnly)).not.toThrow();

    database
      .prepare("UPDATE documents SET title = ? WHERE workspace_id = ?")
      .run("unexpected migration rewrite", workspace.id);
    const afterRewrite = captureDatabaseFingerprint(database, before);
    expect(() => assertDatabaseFingerprintEqual(before, afterRewrite)).toThrow(
      /documents changed during a data-preserving migration/,
    );
  });

  it("checks SQLite integrity and foreign keys", () => {
    const database = createTestDatabase();
    databases.push(database);
    expect(assertDatabaseIntegrity(database)).toEqual({
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      tenantBoundaryViolations: 0,
    });
  });
});
