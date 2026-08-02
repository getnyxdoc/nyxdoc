import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { parseCollaborationRoomName } from "@/lib/collaboration/drafts";
import { commitWorkingDocument } from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = await request.json() as {
      roomName?: unknown;
      draftVersion?: unknown;
      generation?: unknown;
      stateVector?: unknown;
      summary?: unknown;
    };
    if (typeof body.roomName !== "string") {
      throw new DocumentServiceError("INVALID_INPUT", "roomName이 필요합니다.");
    }
    const room = parseCollaborationRoomName(body.roomName);
    if (room.workspaceId !== workspace.id) {
      throw new DocumentServiceError("FORBIDDEN", "워크스페이스가 일치하지 않습니다.");
    }
    if (!Number.isInteger(body.draftVersion) || Number(body.draftVersion) < 0) {
      throw new DocumentServiceError("INVALID_INPUT", "draftVersion이 필요합니다.");
    }
    if (!Number.isInteger(body.generation) || Number(body.generation) < 1) {
      throw new DocumentServiceError("INVALID_INPUT", "generation이 필요합니다.");
    }
    if (typeof body.stateVector !== "string" || !body.stateVector) {
      throw new DocumentServiceError("INVALID_INPUT", "stateVector가 필요합니다.");
    }
    requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      room.documentId,
      session.user.id,
      "documents.commit",
    );
    const actor = humanDocumentActor(session.user);
    const result = await commitWorkingDocument({
      roomName: body.roomName,
      actor: {
        type: "human",
        userId: actor.userId,
        principalId: actor.principalId,
        label: actor.label,
        avatarMediaId: actor.avatarMediaId,
        source: "web",
      },
      expectedDraftVersion: Number(body.draftVersion),
      synchronizationFence: {
        generation: Number(body.generation),
        stateVector: body.stateVector,
      },
      summary: typeof body.summary === "string" ? body.summary : undefined,
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
