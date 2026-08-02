import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { revokeDocumentHumanGrant } from "@/lib/sharing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string; userId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.share");
    const { documentId, userId } = await context.params;
    revokeDocumentHumanGrant(sqlite, {
      workspaceId: workspace.id,
      documentId,
      recipientUserId: userId,
      actorUserId: session.user.id,
      actorLabel: session.user.name,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
