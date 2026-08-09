import { withVerifiedDestructiveOperationBackup } from "../src/lib/db/backup";
import { openDatabase } from "../src/lib/db/client";
import {
  getBackupRoot,
  getCollaborationInternalUrl,
  getCollaborationSecret,
  getDatabasePath,
  getMediaRoot,
} from "../src/lib/config";
import { purgeExpiredTrash } from "../src/lib/documents/service";

async function main() {
  const databasePath = getDatabasePath();
  const database = openDatabase(databasePath);
  try {
    const now = new Date().toISOString();
    const due = database.prepare(
      `SELECT COUNT(*) AS count
       FROM document_trash_batches b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE w.trash_auto_purge = 1 AND b.purge_after <= ?`,
    ).get(now) as { count: number };
    if (Number(due.count) === 0) {
      console.log(JSON.stringify({ dueBatches: 0, purgedDocuments: 0 }));
      return;
    }
    const protectedOperation = await withVerifiedDestructiveOperationBackup({
      baseUrl: getCollaborationInternalUrl(),
      secret: getCollaborationSecret(),
      databasePath,
      mediaRoot: getMediaRoot(),
      backupRoot: getBackupRoot(),
      sourceRevision: process.env.NYXDOC_SOURCE_REVISION?.trim() || "scheduled-trash-purge",
      operation: (backup) => ({
        backupGenerationId: backup.manifest.generationId,
        results: purgeExpiredTrash(database, {
          type: "system",
          userId: "system",
          label: "Nyxdoc 보존 정책",
          source: "web",
        }, now),
      }),
      onWarning(warning) {
        console.warn("[nyxdoc] scheduled trash purge barrier warning", { warning });
      },
    });
    const { backupGenerationId, results } = protectedOperation.result;
    console.log(JSON.stringify({
      dueBatches: Number(due.count),
      purgedDocuments: results.reduce((total, result) => total + result.documentCount, 0),
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
