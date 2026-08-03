import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { resetWorkingDocument } from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { discardWorkingDocumentSchema } from "@/lib/documents/schemas";
import { getDocument } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = discardWorkingDocumentSchema.parse(await request.json());
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
      expectedGeneration: body.expectedGeneration,
      expectedDraftVersion: body.expectedDraftVersion,
      expectedBaseRevision: body.expectedBaseRevision,
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
