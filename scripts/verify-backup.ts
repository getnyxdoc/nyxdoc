import path from "node:path";
import { verifyBackupGeneration } from "../src/lib/db/backup";

async function verify() {
  const generationPath = process.argv[2];
  if (!generationPath) {
    throw new Error("Usage: npm run backup:verify -- <generation-directory>");
  }
  const verified = await verifyBackupGeneration(path.resolve(generationPath));
  console.log(JSON.stringify({
    status: "verified",
    generationId: verified.manifest.generationId,
    generationPath: verified.generationPath,
    databaseSha256: verified.manifest.database.sha256,
    mediaTreeSha256: verified.manifest.media.treeSha256,
    sourceRevision: verified.manifest.sourceRevision,
  }, null, 2));
}

verify().catch((error) => {
  console.error("Nyxdoc backup verification failed.", error);
  process.exitCode = 1;
});
