import { sqlite } from "@/lib/db/client";
import { getChanges } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenPermission,
  setTokenCursor,
  tokenCanAccessDocument,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenPermission(identity, "changes:read", "changes.read");
    const url = new URL(request.url);
    const sinceValue = url.searchParams.get("since");
    const limitValue = url.searchParams.get("limit");
    const since = sinceValue === null ? identity.lastEventCursor : Number(sinceValue);
    const limit = limitValue === null ? 50 : Number(limitValue);
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DocumentServiceError("INVALID_INPUT", "since와 limit 값을 확인해주세요.");
    }
    const result = getChanges(sqlite, identity.workspaceId, since, limit);
    if (sinceValue === null) setTokenCursor(sqlite, identity.id, result.nextCursor, identity.workspaceId);
    return Response.json({
      ...result,
      events: result.events.filter((event) => tokenCanAccessDocument(sqlite, identity, event.documentId, true)),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
