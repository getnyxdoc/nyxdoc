import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { diagnosticsDisabledResponse } from "@/lib/diagnostics/config";
import { DocumentServiceError } from "@/lib/documents/types";
import { parseEditorDiagnosticEvent } from "@/lib/editor/diagnostics";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const disabled = diagnosticsDisabledResponse();
    if (disabled) return disabled;
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const event = parseEditorDiagnosticEvent(await request.json());
    if (event.workspaceId !== workspace.id) {
      throw new DocumentServiceError("FORBIDDEN", "워크스페이스가 일치하지 않습니다.");
    }
    requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      event.documentId,
      session.user.id,
      "documents.read",
    );
    const documentExists = sqlite.prepare(
      `SELECT 1 FROM documents
       WHERE workspace_id = ? AND id = ? AND status = 'active'`,
    ).get(workspace.id, event.documentId);
    if (!documentExists) {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }

    console.warn("[editor-diagnostic]", JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "web",
      event: event.event,
      workspaceId: workspace.id,
      documentId: event.documentId,
      userId: session.user.id,
      details: event.details,
    }));
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
