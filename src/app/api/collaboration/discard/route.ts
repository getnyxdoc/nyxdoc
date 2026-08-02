import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { resetWorkingDocument } from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { getDocument } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = await request.json() as { documentId?: unknown };
    if (typeof body.documentId !== "string") {
      throw new DocumentServiceError("INVALID_INPUT", "documentId가 필요합니다.");
    }
    requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      body.documentId,
      session.user.id,
      "documents.update",
    );
    getDocument(sqlite, workspace.id, body.documentId);
    const actor = humanDocumentActor(session.user);
    const result = await resetWorkingDocument({
      workspaceId: workspace.id,
      documentId: body.documentId,
      actor: {
        type: "human",
        userId: actor.userId,
        principalId: actor.principalId,
        label: actor.label,
        avatarMediaId: actor.avatarMediaId,
        source: "web",
      },
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
