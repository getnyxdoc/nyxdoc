import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  humanDocumentPrincipalAllows,
  requireHumanDocumentPermission,
} from "@/lib/authz/permissions";
import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import { createCollaborationToken } from "@/lib/collaboration/token";
import { getCollaborationPublicUrl } from "@/lib/config";
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
    const principal = requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      body.documentId,
      session.user.id,
      "documents.read",
    );
    getDocument(sqlite, workspace.id, body.documentId);
    const state = ensureCollaborationState(sqlite, workspace.id, body.documentId);
    const actor = humanDocumentActor(session.user);
    const canWrite = humanDocumentPrincipalAllows(principal, "documents.update");
    const canCommit = humanDocumentPrincipalAllows(principal, "documents.commit");
    const token = createCollaborationToken({
      roomName: state.roomName,
      workspaceId: state.workspaceId,
      documentId: state.documentId,
      generation: state.generation,
      actor: {
        type: "human",
        userId: actor.userId,
        principalId: actor.principalId,
        label: actor.label,
        avatarMediaId: actor.avatarMediaId,
        source: "web",
      },
      permissions: { read: true, write: canWrite, commit: canCommit },
    });
    return Response.json({
      token,
      roomName: state.roomName,
      publicUrl: getCollaborationPublicUrl(request.url),
      generation: state.generation,
      draftVersion: state.draftVersion,
      committedDraftVersion: state.committedDraftVersion,
      hasUncommittedChanges: state.hasUncommittedChanges,
      permissions: { canWrite, canCommit },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
