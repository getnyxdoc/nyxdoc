import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const code = process.argv[2]?.trim().toUpperCase();
  if (!code || !/^CAR-\d{8}-[0-9A-F]{8}$/.test(code)) {
    throw new Error("Usage: npm run diagnostics:caret -- CAR-YYYYMMDD-XXXXXXXX");
  }

  const [{ getDatabasePath }, { openDatabase }, { getEditorCaretIncidentByCode }] = await Promise.all([
    import("../src/lib/config"),
    import("../src/lib/db/client"),
    import("../src/lib/editor/caret-incidents"),
  ]);
  const database = openDatabase(getDatabasePath());
  try {
    const incident = getEditorCaretIncidentByCode(database, code);
    if (!incident) throw new Error(`Caret incident not found or expired: ${code}`);
    console.log(JSON.stringify(incident, null, 2));
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
