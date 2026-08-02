import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  disableDocumentPublicShare,
  enableDocumentPublicShare,
  getDocumentPublicShare,
} from "@/lib/sharing/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseShare(share: ReturnType<typeof getDocumentPublicShare>) {
  return {
    enabled: share?.enabled ?? false,
    urlPath: share ? `/s/${share.publicToken}` : null,
    createdAt: share?.createdAt ?? null,
    updatedAt: share?.updatedAt ?? null,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.share");
    const { documentId } = await context.params;
    return Response.json({
      share: responseShare(getDocumentPublicShare(sqlite, workspace.id, documentId)),
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.share");
    const { documentId } = await context.params;
    const share = enableDocumentPublicShare(sqlite, {
      workspaceId: workspace.id,
      documentId,
      userId: session.user.id,
      actorLabel: session.user.name,
    });
    return Response.json(
      { share: responseShare(share) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.share");
    const { documentId } = await context.params;
    const share = disableDocumentPublicShare(sqlite, {
      workspaceId: workspace.id,
      documentId,
      userId: session.user.id,
      actorLabel: session.user.name,
    });
    return Response.json(
      { share: responseShare(share) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
