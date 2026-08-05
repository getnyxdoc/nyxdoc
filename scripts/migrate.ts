import { loadEnvConfig } from "@next/env";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

loadEnvConfig(process.cwd());

async function migrate() {
  const { assertRuntimeConfiguration } = await import("../src/lib/config");
  assertRuntimeConfiguration();
  const [
    { auth },
    { openDatabase, sqlite },
    { getAppMigrationPlan, runAppMigrations },
    { assertDatabaseFingerprintEqual, assertDatabaseIntegrity, captureDatabaseFingerprint },
    { createBackupGeneration, verifyBackupGeneration },
    { getBackupRoot, getDatabasePath, getMediaRoot },
    { getMigrations },
    { purgeExpiredBugReports },
  ] = await Promise.all([
    import("../src/lib/auth"),
    import("../src/lib/db/client"),
    import("../src/lib/db/migrations"),
    import("../src/lib/db/integrity"),
    import("../src/lib/db/backup"),
    import("../src/lib/config"),
    import("better-auth/db/migration"),
    import("../src/lib/diagnostics/bug-reports"),
  ]);

  const authMigrations = await getMigrations(auth.options);
  const appPlan = getAppMigrationPlan(sqlite);
  const authPending = authMigrations.toBeCreated.length + authMigrations.toBeAdded.length > 0;
  if (!authPending && appPlan.pending.length === 0) {
    runAppMigrations(sqlite, { sourceRevision: process.env.NYXDOC_SOURCE_REVISION });
    await purgeExpiredBugReports(sqlite);
    assertDatabaseIntegrity(sqlite);
    console.log("Nyxdoc database is up to date; no backup generation was required.");
    return;
  }

  const databasePath = getDatabasePath();
  if (databasePath === ":memory:") throw new Error("Migration preflight requires a file database.");
  const sourceRevision = process.env.NYXDOC_SOURCE_REVISION?.trim() || "unknown";
  const generation = await createBackupGeneration({
    databasePath,
    mediaRoot: getMediaRoot(),
    backupRoot: getBackupRoot(),
    sourceRevision,
  });
  await verifyBackupGeneration(generation.generationPath);

  const temporary = await mkdtemp(path.join(tmpdir(), "nyxdoc-migration-"));
  const clonePath = path.join(temporary, "nyxdoc-preflight.db");
  const receiptPath = path.join(generation.generationPath, "migration-receipt.json");
  const planned = {
    auth: {
      createTables: authMigrations.toBeCreated.map((entry) => entry.table),
      addFields: authMigrations.toBeAdded.map((entry) => entry.table),
    },
    app: appPlan.pending,
  };
  const startedAt = new Date().toISOString();

  try {
    await copyFile(path.join(generation.generationPath, "nyxdoc.db"), clonePath);
    const clone = openDatabase(clonePath);
    try {
      const cloneBefore = captureDatabaseFingerprint(clone);
      if (authPending) clone.exec(await authMigrations.compileMigrations());
      runAppMigrations(clone, { sourceRevision });
      const cloneAfter = captureDatabaseFingerprint(clone, cloneBefore);
      assertDatabaseFingerprintEqual(cloneBefore, cloneAfter);
      assertDatabaseIntegrity(clone);
    } finally {
      clone.close();
    }

    const liveBefore = captureDatabaseFingerprint(sqlite);
    if (authPending) await authMigrations.runMigrations();
    const appResult = runAppMigrations(sqlite, { sourceRevision });
    const liveAfter = captureDatabaseFingerprint(sqlite, liveBefore);
    assertDatabaseFingerprintEqual(liveBefore, liveAfter);
    assertDatabaseIntegrity(sqlite);
    await purgeExpiredBugReports(sqlite);
    await writeFile(receiptPath, `${JSON.stringify({
      format: "nyxdoc-migration-receipt/v1",
      outcome: "succeeded",
      sourceRevision,
      backupGenerationId: generation.manifest.generationId,
      backupDatabaseSha256: generation.manifest.database.sha256,
      planned,
      appRunId: appResult.runId,
      startedAt,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      status: "migrated",
      sourceRevision,
      backupGeneration: generation.generationPath,
      appMigrations: appResult.appliedIds,
      authTablesCreated: planned.auth.createTables,
      authTablesExtended: planned.auth.addFields,
    }, null, 2));
  } catch (error) {
    await writeFile(receiptPath, `${JSON.stringify({
      format: "nyxdoc-migration-receipt/v1",
      outcome: "failed",
      sourceRevision,
      backupGenerationId: generation.manifest.generationId,
      backupDatabaseSha256: generation.manifest.database.sha256,
      planned,
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

migrate().catch((error) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
