import { randomUUID } from "node:crypto";
import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  humanDocumentPrincipalAllows,
  requireHumanDocumentPermission,
} from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { createAppBugReport } from "@/lib/diagnostics/bug-reports";
import { diagnosticsDisabledResponse } from "@/lib/diagnostics/config";
import {
  diagnosticCountBucket,
  parseAppBugReportRequest,
  sanitizeEditorTrace,
  type AppBugReportRequest,
} from "@/lib/diagnostics/schema";
import { parseEditorCaretIncidentRequest } from "@/lib/editor/diagnostics";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const disabled = diagnosticsDisabledResponse();
    if (disabled) return disabled;
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const input = parseEditorCaretIncidentRequest(await request.json());
    if (input.workspaceId !== workspace.id) {
      throw new DocumentServiceError("FORBIDDEN", "워크스페이스가 일치하지 않습니다.");
    }
    const principal = requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      input.documentId,
      session.user.id,
      "documents.read",
    );
    const documentExists = sqlite.prepare(
      `SELECT 1 FROM documents
       WHERE workspace_id = ? AND id = ? AND status = 'active'`,
    ).get(workspace.id, input.documentId);
    if (!documentExists) {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }

    const lastEvent = input.trace.at(-1);
    const capturedAt = new Date().toISOString();
    const detector = input.reason === "manual" ? undefined : input.reason;
    const automatic = input.trigger === "automatic" && detector !== undefined;
    const report = {
      schemaVersion: 1,
      clientReportId: input.clientIncidentId,
      sessionId: randomUUID(),
      trigger: automatic ? "automatic" : "manual",
      category: "editor_caret",
      categorySource: automatic ? "detector" : "suggested",
      suggestedCategory: "editor_caret",
      ...(automatic ? { detector } : {}),
      reasonCode: automatic ? detector : "manual_report",
      capturedAt,
      clientBuildSha: "unknown",
      documentId: input.documentId,
      environment: {
        browser: input.environment.browser,
        browserMajor: input.environment.browserMajor,
        platform: input.environment.platform,
        viewportClass: input.environment.viewportWidth < 720
          ? "compact"
          : input.environment.viewportWidth < 1_200
            ? "medium"
            : "wide",
        locale: input.environment.locale,
        online: true,
      },
      snapshot: {
        surface: "editor",
        editorMode: "edit",
        canonicalRevision: 0,
        generation: 0,
        draftVersion: 0,
        committedDraftVersion: 0,
        dirty: true,
        syncState: "synced",
        validationState: "valid",
        visibility: "visible",
        accessKind: principal.source === "workspace"
          ? workspace.accessSource
          : "document_grant",
        workspaceRole: principal.role,
        canRead: true,
        canEdit: humanDocumentPrincipalAllows(principal, "documents.update"),
        canCommit: humanDocumentPrincipalAllows(principal, "documents.commit"),
        canShare: humanDocumentPrincipalAllows(principal, "documents.share"),
        blockCount: diagnosticCountBucket(lastEvent?.blockCount ?? 0),
        textLength: "zero",
        nodeTypeCount: "zero",
        documentCount: "zero",
        sidebarWidth: "standard",
      },
      events: [],
      editorTrace: sanitizeEditorTrace(input.trace),
    } satisfies AppBugReportRequest;
    const incident = createAppBugReport(sqlite, {
      workspaceId: workspace.id,
      documentId: input.documentId,
      reporterUserId: session.user.id,
      report: parseAppBugReportRequest(report),
    });
    console.warn("[editor-caret-incident]", JSON.stringify({
      timestamp: incident.createdAt,
      source: "web",
      incidentCode: incident.reportCode,
      trigger: incident.trigger,
      reason: incident.reasonCode,
      workspaceId: workspace.id,
      documentId: input.documentId,
      userId: session.user.id,
      traceEventCount: report.editorTrace.length,
    }));
    return Response.json({
      incident: {
        code: incident.reportCode,
        createdAt: incident.createdAt,
        expiresAt: incident.expiresAt,
      },
    }, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
