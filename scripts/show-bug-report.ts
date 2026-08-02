import { getDatabasePath } from "../src/lib/config";
import { openDatabase } from "../src/lib/db/client";
import { getAppBugReportByCode } from "../src/lib/diagnostics/bug-reports";

async function main() {
  const code = process.argv[2]?.trim();
  if (!code) throw new Error("Usage: npm run diagnostics:bug -- BUG-...");
  const database = openDatabase(getDatabasePath());
  try {
    const report = getAppBugReportByCode(database, code);
    if (!report) throw new Error(`Active bug report ${code} was not found.`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
