import { z } from "zod";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { updateAgentWorkspaceMembership } from "@/lib/agents/service";
import { WORKSPACE_PERMISSIONS } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  role: z.enum(["admin", "editor", "viewer"]),
  rootDocumentId: z.string().uuid().nullable(),
  permissionAllow: z.array(z.enum(WORKSPACE_PERMISSIONS)).max(WORKSPACE_PERMISSIONS.length),
  permissionDeny: z.array(z.enum(WORKSPACE_PERMISSIONS)).max(WORKSPACE_PERMISSIONS.length),
  status: z.enum(["active", "disabled"]).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const { agentId } = await context.params;
    const body = updateSchema.parse(await request.json());
    return Response.json({
      membership: updateAgentWorkspaceMembership(sqlite, {
        userId: session.user.id,
        workspaceId: workspace.id,
        agentId,
        ...body,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
