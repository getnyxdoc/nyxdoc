import { z } from "zod";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { updateAgentWorkspaceMembership } from "@/lib/agents/service";
import { AGENT_ACCESS_PROFILES, WORKSPACE_PERMISSIONS } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  accessProfile: z.enum(AGENT_ACCESS_PROFILES),
  capabilities: z.array(z.enum(WORKSPACE_PERMISSIONS)).max(WORKSPACE_PERMISSIONS.length).optional(),
  rootDocumentId: z.string().uuid().nullable(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.accessProfile === "custom" && !value.capabilities?.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "A custom access profile requires at least one capability.",
    });
  }
  if (value.accessProfile !== "custom" && value.capabilities !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Fixed access profiles define their own capabilities.",
    });
  }
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
