import { createBackupGeneration, verifyBackupGeneration } from "../src/lib/db/backup";
import { openDatabase } from "../src/lib/db/client";
import { getBackupRoot, getDatabasePath, getMediaRoot } from "../src/lib/config";
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
    const backupGeneration = await createBackupGeneration({
      databasePath,
      mediaRoot: getMediaRoot(),
      backupRoot: getBackupRoot(),
      sourceRevision: process.env.NYXDOC_SOURCE_REVISION?.trim() || "scheduled-trash-purge",
    });
    const backup = await verifyBackupGeneration(backupGeneration.generationPath);
    const results = purgeExpiredTrash(database, {
      type: "system",
      userId: "system",
      label: "Nyxdoc 보존 정책",
      source: "web",
    }, now);
    console.log(JSON.stringify({
      dueBatches: Number(due.count),
      purgedDocuments: results.reduce((total, result) => total + result.documentCount, 0),
      backupGenerationId: backup.manifest.generationId,
    }));
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
