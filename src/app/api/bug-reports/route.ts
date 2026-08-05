import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import {
  BugReportError,
  createAppBugReport,
} from "@/lib/diagnostics/bug-reports";
import { diagnosticsDisabledResponse } from "@/lib/diagnostics/config";
import {
  BUG_REPORT_ATTACHMENT_MIME_TYPES,
  MAX_BUG_REPORT_ATTACHMENT_BYTES,
  MAX_BUG_REPORT_ATTACHMENTS,
  parseAppBugReportRequest,
} from "@/lib/diagnostics/schema";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  removeUnreferencedDiagnosticMedia,
  storeMediaAsset,
  type SupportedImageMimeType,
} from "@/lib/media/service";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 300 * 1_024;
const MAX_MULTIPART_REQUEST_BYTES = (
  MAX_BUG_REPORT_ATTACHMENTS * MAX_BUG_REPORT_ATTACHMENT_BYTES
) + (1 * 1_024 * 1_024);

async function parseRequest(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      throw new BugReportError("TOO_LARGE", "The bug report payload is too large.");
    }
    return {
      report: parseAppBugReportRequest(JSON.parse(raw)),
      attachments: [] as File[],
    };
  }

  const form = await request.formData();
  const reportJson = form.get("report");
  if (typeof reportJson !== "string") {
    throw new BugReportError("INVALID_INPUT", "The multipart report field is required.");
  }
  if (Buffer.byteLength(reportJson, "utf8") > MAX_REQUEST_BYTES) {
    throw new BugReportError("TOO_LARGE", "The bug report payload is too large.");
  }
  const report = parseAppBugReportRequest(JSON.parse(reportJson));
  const attachments = form.getAll("attachment").filter(
    (value): value is File => typeof value !== "string" && value.size > 0,
  );
  if (report.trigger !== "manual" && attachments.length > 0) {
    throw new BugReportError("INVALID_INPUT", "Automatic reports cannot include attachments.");
  }
  if (attachments.length > MAX_BUG_REPORT_ATTACHMENTS) {
    throw new BugReportError("INVALID_INPUT", "Too many bug report attachments.");
  }
  for (const attachment of attachments) {
    if (attachment.size > MAX_BUG_REPORT_ATTACHMENT_BYTES) {
      throw new BugReportError("TOO_LARGE", "A bug report attachment is too large.");
    }
    if (!BUG_REPORT_ATTACHMENT_MIME_TYPES.includes(
      attachment.type as (typeof BUG_REPORT_ATTACHMENT_MIME_TYPES)[number],
    )) {
      throw new BugReportError("INVALID_INPUT", "Unsupported bug report attachment type.");
    }
  }
  return { report, attachments };
}

function errorResponse(code: string, status: number) {
  return Response.json({ code, error: code }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const uploadedMediaIds: string[] = [];
  let attachmentsBound = false;
  try {
    const disabled = diagnosticsDisabledResponse();
    if (disabled) return disabled;
    assertSameOrigin(request);
    const multipart = (request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("multipart/form-data");
    const contentLength = Number(request.headers.get("content-length"));
    const requestLimit = multipart ? MAX_MULTIPART_REQUEST_BYTES : MAX_REQUEST_BYTES;
    if (Number.isFinite(contentLength) && contentLength > requestLimit) {
      return errorResponse("TOO_LARGE", 413);
    }
    const { report, attachments } = await parseRequest(request);
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

    for (const attachment of attachments) {
      const media = await storeMediaAsset(sqlite, {
        bytes: await attachment.arrayBuffer(),
        originalFilename: attachment.name,
        expectedByteSize: attachment.size,
        expectedMimeType: attachment.type as SupportedImageMimeType,
        purpose: "diagnostic",
        userId: session.user.id,
        workspaceId: workspace.id,
      });
      uploadedMediaIds.push(media.id);
    }

    const stored = await createAppBugReport(sqlite, {
      workspaceId: workspace.id,
      documentId,
      reporterUserId: session.user.id,
      report,
      attachmentMediaIds: uploadedMediaIds,
    });
    attachmentsBound = stored.createdNew === true;
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
      attachmentCount: attachmentsBound ? uploadedMediaIds.length : 0,
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
        error.code === "RATE_LIMITED" ? 429 : error.code === "TOO_LARGE" ? 413 : 400,
      );
    }
    return apiErrorResponse(error);
  } finally {
    if (!attachmentsBound && uploadedMediaIds.length > 0) {
      try {
        await removeUnreferencedDiagnosticMedia(sqlite, uploadedMediaIds);
      } catch (error) {
        console.warn("[bug-report-upload-cleanup-failed]", error);
      }
    }
  }
}
