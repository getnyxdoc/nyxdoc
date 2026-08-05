import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { MediaServiceError, readMediaAsset } from "@/lib/media/service";
import { isSiteAdministrator } from "@/lib/site-settings/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ reportCode: string; attachmentId: string }> },
) {
  try {
    const session = await requireVerifiedSession();
    const { reportCode, attachmentId } = await context.params;
    const row = sqlite.prepare(
      `SELECT report.reporter_user_id AS reporterUserId,
              attachment.workspace_id AS workspaceId,
              attachment.media_id AS mediaId
       FROM app_bug_reports report
       JOIN app_bug_report_attachments attachment
         ON attachment.bug_report_id = report.id
       WHERE report.report_code = ?
         AND attachment.id = ?
         AND report.expires_at > ?`,
    ).get(reportCode, attachmentId, new Date().toISOString()) as {
      reporterUserId: string | null;
      workspaceId: string;
      mediaId: string;
    } | undefined;
    if (
      !row
      || (
        row.reporterUserId !== session.user.id
        && !isSiteAdministrator(sqlite, session.user)
      )
    ) {
      throw new MediaServiceError("NOT_FOUND", "이미지를 찾을 수 없습니다.");
    }

    const { asset, bytes } = await readMediaAsset(sqlite, row.workspaceId, row.mediaId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(bytes.length),
        "Content-Type": asset.mimeType,
        ETag: `"${asset.sha256}"`,
        Vary: "Cookie",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
