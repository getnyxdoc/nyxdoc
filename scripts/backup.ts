import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function backup() {
  const [{
    assertRuntimeConfiguration,
    getBackupRoot,
    getCollaborationInternalUrl,
    getCollaborationSecret,
    getDatabasePath,
    getMediaRoot,
  }, backupModule] =
    await Promise.all([
      import("../src/lib/config"),
      import("../src/lib/db/backup"),
    ]);
  assertRuntimeConfiguration();
  const databasePath = getDatabasePath();
  const mediaRoot = getMediaRoot();
  const backupRoot = option("--output") ?? getBackupRoot();
  const sourceRevision = option("--source-revision")
    ?? process.env.NYXDOC_SOURCE_REVISION
    ?? "unknown";
  const generation = await backupModule.withCollaborationBackupBarrier({
    baseUrl: getCollaborationInternalUrl(),
    secret: getCollaborationSecret(),
    callback: async ({ receipt, assertHeld }) => {
      const created = await backupModule.createLiveBackupGeneration({
        databasePath,
        mediaRoot,
        backupRoot,
        sourceRevision,
        collaborationBarrier: receipt,
        assertCollaborationBarrierHeld: assertHeld,
      });
      await backupModule.verifyBackupGeneration(created.generationPath);
      await assertHeld();
      return created;
    },
  });
  console.log(JSON.stringify({
    status: "verified",
    generationId: generation.manifest.generationId,
    generationPath: generation.generationPath,
    databaseSha256: generation.manifest.database.sha256,
    databaseBytes: generation.manifest.database.byteSize,
    mediaFiles: generation.manifest.media.fileCount,
    mediaBytes: generation.manifest.media.totalBytes,
    sourceRevision: generation.manifest.sourceRevision,
    collaborationBarrierId: generation.manifest.collaborationBarrier?.barrierId,
    collaborationFlushWatermark: generation.manifest.collaborationBarrier?.flushWatermark,
    collaborationLoadedDocuments: generation.manifest.collaborationBarrier?.loadedDocumentCount,
  }, null, 2));
}

backup().catch((error) => {
  console.error("Nyxdoc backup failed.", error);
  process.exitCode = 1;
});
