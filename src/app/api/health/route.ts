import { assertRuntimeConfiguration } from "@/lib/config";
import { sqlite } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    assertRuntimeConfiguration();
    sqlite.prepare("SELECT 1").get();
    return Response.json(
      { status: "ok" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
