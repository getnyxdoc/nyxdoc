import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { updateSavedViewSchema } from "@/lib/collaboration/schemas";
import { deleteSavedView, updateSavedView } from "@/lib/collaboration/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ viewId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const principal = requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "saved_views.manage");
    const { viewId } = await context.params;
    const body = updateSavedViewSchema.parse(await request.json());
    const view = updateSavedView(
      sqlite,
      workspace.id,
      viewId,
      { type: "human", userId: session.user.id, label: session.user.name },
      body,
      { allowWorkspaceAdmin: principal.role === "owner" || principal.role === "admin" },
    );
    return Response.json({ view });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ viewId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const principal = requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "saved_views.manage");
    const { viewId } = await context.params;
    deleteSavedView(
      sqlite,
      workspace.id,
      viewId,
      { type: "human", userId: session.user.id, label: session.user.name },
      { allowWorkspaceAdmin: principal.role === "owner" || principal.role === "admin" },
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
