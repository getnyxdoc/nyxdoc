import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import {
  BugReportError,
  createAppBugReport,
} from "@/lib/diagnostics/bug-reports";
import { diagnosticsDisabledResponse } from "@/lib/diagnostics/config";
import { parseAppBugReportRequest } from "@/lib/diagnostics/schema";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 300 * 1_024;

function errorResponse(code: string, status: number) {
  return Response.json({ code, error: code }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const disabled = diagnosticsDisabledResponse();
    if (disabled) return disabled;
    assertSameOrigin(request);
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return errorResponse("TOO_LARGE", 413);
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return errorResponse("TOO_LARGE", 413);
    }
    const report = parseAppBugReportRequest(JSON.parse(raw));
    const { session, workspace } = await requireWorkspaceSession(request);

    let documentId: string | null = null;
    if (report.documentId) {
      try {
        requireHumanDocumentPermission(
          sqlite,
          workspace.id,
          report.documentId,
          session.user.id,
          "documents.read",
        );
        const active = sqlite.prepare(
          `SELECT 1 FROM documents
           WHERE workspace_id = ? AND id = ? AND status = 'active'`,
        ).get(workspace.id, report.documentId);
        if (active) documentId = report.documentId;
      } catch {
        // A report about an access failure must remain possible without
        // confirming whether an inaccessible document exists.
        documentId = null;
      }
    }

    const stored = createAppBugReport(sqlite, {
      workspaceId: workspace.id,
      documentId,
      reporterUserId: session.user.id,
      report,
    });
    console.warn("[app-bug-report]", JSON.stringify({
      timestamp: stored.createdAt,
      source: "web",
      reportCode: stored.reportCode,
      trigger: stored.trigger,
      category: stored.category,
      detector: stored.detector,
      workspaceId: workspace.id,
      documentId,
      occurrenceCount: stored.occurrenceCount,
      deduplicated: stored.deduplicated === true,
    }));
    return Response.json({
      report: {
        code: stored.reportCode,
        createdAt: stored.createdAt,
        expiresAt: stored.expiresAt,
      },
    }, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof BugReportError) {
      return errorResponse(
        error.code,
        error.code === "RATE_LIMITED" ? 429 : 413,
      );
    }
    return apiErrorResponse(error);
  }
}
