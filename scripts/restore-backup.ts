import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function restore() {
  const generationPath = process.argv[2];
  const databasePath = option("--database");
  const mediaRoot = option("--media");
  const confirmedGenerationId = option("--confirm-generation");
  if (!generationPath || !databasePath || !mediaRoot || !confirmedGenerationId) {
    throw new Error(
      "Usage: npm run backup:restore -- <generation-directory> "
      + "--database <empty-target.db> --media <missing-target-directory> "
      + "--confirm-generation <generation-id>",
    );
  }
  const { restoreBackupGeneration } = await import("../src/lib/db/backup");
  const result = await restoreBackupGeneration({
    generationPath,
    databasePath,
    mediaRoot,
    confirmedGenerationId,
  });
  console.log(JSON.stringify({ status: "restored-and-verified", ...result }, null, 2));
}

restore().catch((error) => {
  console.error("Nyxdoc backup restore failed.", error);
  process.exitCode = 1;
});
