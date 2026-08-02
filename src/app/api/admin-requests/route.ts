import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { listAdminActionRequests } from "@/lib/admin-requests/service";
import type { AdminActionStatus } from "@/lib/admin-requests/types";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set<AdminActionStatus>([
  "pending", "executed", "rejected", "failed", "expired",
]);

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(
      sqlite,
      workspace.id,
      session.user.id,
      "admin_requests.read",
    );
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get("status") as AdminActionStatus | null;
    const status = requestedStatus && STATUSES.has(requestedStatus) ? requestedStatus : undefined;
    return Response.json({
      requests: listAdminActionRequests(sqlite, workspace.id, { status, limit: 100 }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
