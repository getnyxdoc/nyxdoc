import { withVerifiedDestructiveOperationBackup } from "../src/lib/db/backup";
import { openDatabase } from "../src/lib/db/client";
import {
  getBackupRoot,
  getCollaborationInternalUrl,
  getCollaborationSecret,
  getDatabasePath,
  getMediaRoot,
} from "../src/lib/config";
import { purgeExpiredAccountAgents } from "../src/lib/agents/service";

async function main() {
  const databasePath = getDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const now = new Date().toISOString();
    const due = database.prepare(
      `SELECT COUNT(*) AS count
       FROM agents
       WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after <= ?`,
    ).get(now) as { count: number };
    if (Number(due.count) === 0) {
      console.log(JSON.stringify({ dueAgents: 0, purgedAgents: 0 }));
      return;
    }
    const protectedOperation = await withVerifiedDestructiveOperationBackup({
      baseUrl: getCollaborationInternalUrl(),
      secret: getCollaborationSecret(),
      databasePath,
      mediaRoot: getMediaRoot(),
      backupRoot: getBackupRoot(),
      sourceRevision: process.env.NYXDOC_SOURCE_REVISION?.trim() || "scheduled-agent-purge",
      operation: (backup) => ({
        backupGenerationId: backup.manifest.generationId,
        purgedIds: purgeExpiredAccountAgents(database, {
          now,
          backupGenerationId: backup.manifest.generationId,
        }),
      }),
      onWarning(warning) {
        console.warn("[nyxdoc] scheduled agent purge barrier warning", { warning });
      },
    });
    const { backupGenerationId, purgedIds } = protectedOperation.result;
    console.log(JSON.stringify({
      dueAgents: Number(due.count),
      purgedAgents: purgedIds.length,
      purgedAgentIds: purgedIds,
      backupGenerationId,
      barrierWarnings: protectedOperation.warnings.length,
    }));
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
