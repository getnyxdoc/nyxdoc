import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { updateAssignmentSchema } from "@/lib/collaboration/schemas";
import { updateAssignment } from "@/lib/collaboration/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ assignmentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "assignments.manage");
    const { assignmentId } = await context.params;
    const body = updateAssignmentSchema.parse(await request.json());
    const assignment = updateAssignment(
      sqlite,
      workspace.id,
      assignmentId,
      { type: "human", userId: session.user.id, label: session.user.name },
      body,
    );
    return Response.json({ assignment });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ assignmentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "assignments.manage");
    const { assignmentId } = await context.params;
    const assignment = updateAssignment(
      sqlite,
      workspace.id,
      assignmentId,
      { type: "human", userId: session.user.id, label: session.user.name },
      { status: "cancelled" },
    );
    return Response.json({ assignment });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
