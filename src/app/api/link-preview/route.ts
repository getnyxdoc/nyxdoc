import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  requireHumanDocumentPermission,
  requireHumanWorkspacePermission,
} from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { fetchLinkPreview, LinkPreviewError } from "@/lib/links/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = await request.json() as { documentId?: unknown; url?: unknown };
    if (body.documentId !== undefined && typeof body.documentId !== "string") {
      throw new LinkPreviewError("INVALID_URL", "링크를 추가할 문서가 올바르지 않습니다.");
    }
    if (typeof body.documentId === "string") {
      requireHumanDocumentPermission(
        sqlite,
        workspace.id,
        body.documentId,
        session.user.id,
        "documents.read",
      );
    } else {
      requireHumanWorkspacePermission(
        sqlite,
        workspace.id,
        session.user.id,
        "documents.update",
      );
    }
    if (typeof body.url !== "string" || body.url.length > 2_048) {
      throw new LinkPreviewError("INVALID_URL", "올바른 웹 주소가 필요합니다.");
    }
    return Response.json(await fetchLinkPreview(body.url), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof LinkPreviewError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.code === "PRIVATE_ADDRESS" ? 403 : 400 },
      );
    }
    return apiErrorResponse(error);
  }
}
