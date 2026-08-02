import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { listDocumentShareCandidates } from "@/lib/sharing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.share");
    const { documentId } = await context.params;
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json({
      candidates: listDocumentShareCandidates(sqlite, {
        workspaceId: workspace.id,
        documentId,
        currentUserId: session.user.id,
        query,
      }),
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
