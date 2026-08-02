import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { requireMediaRequestIdentity } from "@/lib/media/request-auth";
import { MediaServiceError, readMediaAsset } from "@/lib/media/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
) {
  try {
    const { mediaId } = await context.params;
    const media = sqlite.prepare("SELECT workspace_id FROM media_assets WHERE id = ?")
      .get(mediaId) as { workspace_id: string } | undefined;
    if (!media) throw new MediaServiceError("NOT_FOUND", "이미지를 찾을 수 없습니다.");
    const identity = await requireMediaRequestIdentity(request, "documents:read", {
      documentId: new URL(request.url).searchParams.get("document") ?? undefined,
      mediaId,
      workspaceId: media.workspace_id,
    });
    const { asset, bytes } = await readMediaAsset(sqlite, identity.workspaceId, mediaId);
    const etag = `"${asset.sha256}"`;

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, max-age=31536000, immutable",
          Vary: "Cookie, Authorization",
        },
      });
    }

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(bytes.length),
        "Content-Type": asset.mimeType,
        ETag: etag,
        Vary: "Cookie, Authorization",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
