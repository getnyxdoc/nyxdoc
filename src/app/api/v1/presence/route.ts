import { z } from "zod";
import { agentPresenceSchema } from "@/lib/collaboration/schemas";
import {
  endAgentPresence,
  listWorkspacePresence,
  setAgentPresence,
} from "@/lib/collaboration/presence";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenDocumentAccess,
  requireTokenScope,
  tokenCanAccessDocument,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:read");
    return Response.json({
      presence: listWorkspacePresence(identity.workspaceId)
        .filter((entry) => tokenCanAccessDocument(sqlite, identity, entry.documentId)),
      ttlSeconds: 45,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    const body = agentPresenceSchema.parse(await request.json());
    requireTokenScope(
      identity,
      body.state === "editing" || body.state === "drafting" ? "documents:write" : "documents:read",
    );
    requireTokenDocumentAccess(sqlite, identity, body.documentId);
    const presence = setAgentPresence({
      ...body,
      workspaceId: identity.workspaceId,
      agentId: identity.agentId,
      displayName: identity.name,
      avatarMediaId: identity.avatarMediaId,
    });
    return Response.json({ presence, heartbeatWithinSeconds: 30 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:read");
    const sessionId = z.string().uuid().parse(new URL(request.url).searchParams.get("sessionId"));
    const ended = endAgentPresence(identity.workspaceId, identity.agentId, sessionId);
    return Response.json({ ended });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
