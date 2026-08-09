import { loadEnvConfig } from "@next/env";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

loadEnvConfig(process.cwd());

async function directoryIsMissingOrEmpty(directory: string) {
  try {
    return (await readdir(directory)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function migrate() {
  const { assertRuntimeConfiguration } = await import("../src/lib/config");
  assertRuntimeConfiguration();
  const [
    { auth },
    { openDatabase, sqlite },
    { getAppMigrationPlan, isPristineDatabaseForInitialization, runAppMigrations },
    { assertDatabaseFingerprintEqual, assertDatabaseIntegrity, captureDatabaseFingerprint },
    { withVerifiedMaintenanceOperationBackup },
    {
      getBackupRoot,
      getCollaborationInternalUrl,
      getCollaborationSecret,
      getDatabasePath,
      getMediaRoot,
    },
    { getMigrations },
    { purgeExpiredBugReports },
    { processWorkspaceMediaCleanupQueue },
  ] = await Promise.all([
    import("../src/lib/auth"),
    import("../src/lib/db/client"),
    import("../src/lib/db/migrations"),
    import("../src/lib/db/integrity"),
    import("../src/lib/db/backup"),
    import("../src/lib/config"),
    import("better-auth/db/migration"),
    import("../src/lib/diagnostics/bug-reports"),
    import("../src/lib/media/service"),
  ]);

  const resumeWorkspaceMediaCleanup = async () => {
    const cleanup = await processWorkspaceMediaCleanupQueue(sqlite, {
      mediaRoot: getMediaRoot(),
    });
    if (cleanup.failed.length > 0) {
      console.error("[nyxdoc] workspace media cleanup remains pending", {
        failed: cleanup.failed,
        pending: cleanup.pending,
      });
    }
  };

  const authMigrations = await getMigrations(auth.options);
  const appPlan = getAppMigrationPlan(sqlite);
  const authPending = authMigrations.toBeCreated.length + authMigrations.toBeAdded.length > 0;
  if (!authPending && appPlan.pending.length === 0) {
    runAppMigrations(sqlite, { sourceRevision: process.env.NYXDOC_SOURCE_REVISION });
    await purgeExpiredBugReports(sqlite);
    await resumeWorkspaceMediaCleanup();
    assertDatabaseIntegrity(sqlite);
    console.log("Nyxdoc database is up to date; no backup generation was required.");
    return;
  }

  const databasePath = getDatabasePath();
  if (databasePath === ":memory:") throw new Error("Migration preflight requires a file database.");
  const sourceRevision = process.env.NYXDOC_SOURCE_REVISION?.trim() || "unknown";
  const mediaRoot = getMediaRoot();
  const planned = {
    auth: {
      createTables: authMigrations.toBeCreated.map((entry) => entry.table),
      addFields: authMigrations.toBeAdded.map((entry) => entry.table),
    },
    app: appPlan.pending,
  };
  const compiledAuthMigrations = authPending
    ? await authMigrations.compileMigrations()
    : "";

  const migrateAndVerify = async (
    database: typeof sqlite,
    applyAuthMigrations: () => Promise<void> | void,
  ) => {
    const before = captureDatabaseFingerprint(database);
    await applyAuthMigrations();
    const appResult = runAppMigrations(database, { sourceRevision });
    const after = captureDatabaseFingerprint(database, before);
    assertDatabaseFingerprintEqual(before, after);
    assertDatabaseIntegrity(database);
    return appResult;
  };

  if (
    isPristineDatabaseForInitialization(sqlite)
    && await directoryIsMissingOrEmpty(mediaRoot)
  ) {
    const temporary = await mkdtemp(path.join(tmpdir(), "nyxdoc-initialization-"));
    const clonePath = path.join(temporary, "nyxdoc-preflight.db");
    try {
      // Use SQLite's online backup API so WAL state is included in the
      // preflight snapshot. There is no prior user state, so creating a
      // persistent backup generation would only manufacture an empty backup.
      await sqlite.backup(clonePath);
      const clone = openDatabase(clonePath);
      try {
        await migrateAndVerify(clone, () => {
          if (compiledAuthMigrations) clone.exec(compiledAuthMigrations);
        });
      } finally {
        clone.close();
      }

      const appResult = await migrateAndVerify(sqlite, async () => {
        if (authPending) await authMigrations.runMigrations();
      });
      await purgeExpiredBugReports(sqlite);
      await resumeWorkspaceMediaCleanup();
      console.log(JSON.stringify({
        status: "migrated",
        sourceRevision,
        backupGeneration: null,
        appMigrations: appResult.appliedIds,
        authTablesCreated: planned.auth.createTables,
        authTablesExtended: planned.auth.addFields,
        reason: "pristine-database-no-prior-user-state",
      }, null, 2));
      return;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  const protectedMigration = await withVerifiedMaintenanceOperationBackup({
    baseUrl: getCollaborationInternalUrl(),
    secret: getCollaborationSecret(),
    databasePath,
    mediaRoot,
    backupRoot: getBackupRoot(),
    sourceRevision,
    offlineCheckTimeoutMs: 2_000,
    onWarning: (warning) => console.warn(`Migration backup warning: ${warning}`),
    operation: async (generation) => {
      const temporary = await mkdtemp(path.join(tmpdir(), "nyxdoc-migration-"));
      const clonePath = path.join(temporary, "nyxdoc-preflight.db");
      const receiptPath = path.join(generation.generationPath, "migration-receipt.json");
      const startedAt = new Date().toISOString();

      try {
        await copyFile(path.join(generation.generationPath, "nyxdoc.db"), clonePath);
        const clone = openDatabase(clonePath);
        try {
          await migrateAndVerify(clone, () => {
            if (compiledAuthMigrations) clone.exec(compiledAuthMigrations);
          });
        } finally {
          clone.close();
        }

        const appResult = await migrateAndVerify(sqlite, async () => {
          if (authPending) await authMigrations.runMigrations();
        });
        await purgeExpiredBugReports(sqlite);
        await resumeWorkspaceMediaCleanup();
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
        return {
          backupGeneration: generation.generationPath,
          appMigrations: appResult.appliedIds,
          authTablesCreated: planned.auth.createTables,
          authTablesExtended: planned.auth.addFields,
        };
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
    },
  });
  console.log(JSON.stringify({
    status: "migrated",
    sourceRevision,
    ...protectedMigration.result,
    warnings: protectedMigration.warnings,
  }, null, 2));
}

migrate().catch((error) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
