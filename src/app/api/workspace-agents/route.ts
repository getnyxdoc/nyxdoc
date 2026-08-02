import { z } from "zod";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { assignAgentToWorkspace, listWorkspaceAgentMemberships } from "@/lib/agents/service";
import { WORKSPACE_PERMISSIONS } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignSchema = z.object({
  agentId: z.string().uuid(),
  role: z.enum(["admin", "editor", "viewer"]).optional(),
  rootDocumentId: z.string().uuid().nullable().optional(),
  permissionAllow: z.array(z.enum(WORKSPACE_PERMISSIONS)).max(WORKSPACE_PERMISSIONS.length).optional(),
  permissionDeny: z.array(z.enum(WORKSPACE_PERMISSIONS)).max(WORKSPACE_PERMISSIONS.length).optional(),
});

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    return Response.json({
      memberships: listWorkspaceAgentMemberships(sqlite, workspace.id, session.user.id),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = assignSchema.parse(await request.json());
    return Response.json({
      membership: assignAgentToWorkspace(sqlite, {
        userId: session.user.id,
        workspaceId: workspace.id,
        ...body,
      }),
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
