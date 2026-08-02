import { z } from "zod";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { listWorkspaceAuditEvents } from "@/lib/authz/audit";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "audit.read");
    const url = new URL(request.url);
    const query = z.object({
      beforeCursor: z.coerce.number().int().positive().optional(),
      actionPrefix: z.string().trim().max(100).optional(),
      actorType: z.enum(["system", "human", "agent"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse({
      beforeCursor: url.searchParams.get("beforeCursor") ?? undefined,
      actionPrefix: url.searchParams.get("actionPrefix") ?? undefined,
      actorType: url.searchParams.get("actorType") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return Response.json(listWorkspaceAuditEvents(sqlite, workspace.id, query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
