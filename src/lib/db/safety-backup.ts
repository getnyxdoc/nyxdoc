import "server-only";

import { createBackupGeneration, verifyBackupGeneration } from "@/lib/db/backup";
import { getBackupRoot, getDatabasePath, getMediaRoot } from "@/lib/config";

export async function createDestructiveOperationBackup() {
  const generation = await createBackupGeneration({
    databasePath: getDatabasePath(),
    mediaRoot: getMediaRoot(),
    backupRoot: getBackupRoot(),
    sourceRevision: process.env.NYXDOC_SOURCE_REVISION?.trim() || "development",
  });
  return verifyBackupGeneration(generation.generationPath);
}
