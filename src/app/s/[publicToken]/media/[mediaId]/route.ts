import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { MediaServiceError, readMediaAsset } from "@/lib/media/service";
import {
  getPublicSharedDocument,
  publicDocumentMediaIds,
} from "@/lib/sharing/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ publicToken: string; mediaId: string }> },
) {
  try {
    const { publicToken, mediaId } = await context.params;
    const shared = getPublicSharedDocument(sqlite, publicToken);
    if (!publicDocumentMediaIds(shared.document).has(mediaId)) {
      throw new MediaServiceError("NOT_FOUND", "공유 문서의 이미지를 찾을 수 없습니다.");
    }
    const { asset, bytes } = await readMediaAsset(
      sqlite,
      shared.workspace.id,
      mediaId,
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Length": String(bytes.length),
        "Content-Type": asset.mimeType,
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
