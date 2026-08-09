import "server-only";

import {
  withVerifiedDestructiveOperationBackup,
  type BackupVerification,
} from "@/lib/db/backup";
import {
  getBackupRoot,
  getCollaborationInternalUrl,
  getCollaborationSecret,
  getDatabasePath,
  getMediaRoot,
} from "@/lib/config";

export function withDestructiveOperationBackup<T>(
  operation: (backup: BackupVerification) => Promise<T> | T,
) {
  return withVerifiedDestructiveOperationBackup({
    baseUrl: getCollaborationInternalUrl(),
    secret: getCollaborationSecret(),
    databasePath: getDatabasePath(),
    mediaRoot: getMediaRoot(),
    backupRoot: getBackupRoot(),
    sourceRevision: process.env.NYXDOC_SOURCE_REVISION?.trim() || "development",
    operation,
    onWarning(warning) {
      console.warn("[nyxdoc] destructive operation backup warning", { warning });
    },
  });
}

export async function createDestructiveOperationBackup(): Promise<BackupVerification> {
  throw new Error(
    "Destructive operations must run inside withDestructiveOperationBackup so the live "
    + "collaboration barrier remains held through the database mutation.",
  );
}
