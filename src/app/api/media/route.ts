import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import {
  MAX_MEDIA_BYTES,
  MediaServiceError,
  storeMediaAsset,
} from "@/lib/media/service";
import { requireMediaRequestIdentity } from "@/lib/media/request-auth";
import { bindMediaAssetToDocument } from "@/lib/media/bindings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const documentId = new URL(request.url).searchParams.get("document") ?? undefined;
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES + 1024 * 1024) {
      throw new MediaServiceError("TOO_LARGE", "이미지는 15MB 이하만 업로드할 수 있습니다.");
    }

    const identity = await requireMediaRequestIdentity(request, "documents:write", {
      documentId,
      mutating: true,
    });
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new MediaServiceError("INVALID_INPUT", "업로드할 이미지 파일이 필요합니다.");
    }
    if (file.size > MAX_MEDIA_BYTES) {
      throw new MediaServiceError("TOO_LARGE", "이미지는 15MB 이하만 업로드할 수 있습니다.");
    }

    const media = await storeMediaAsset(sqlite, {
      bytes: await file.arrayBuffer(),
      originalFilename: file.name,
      tokenId: identity.tokenId,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
    });
    if (documentId) {
      bindMediaAssetToDocument(sqlite, {
        workspaceId: identity.workspaceId,
        documentId,
        mediaId: media.id,
      });
    }

    return Response.json(
      {
        media: {
          id: media.id,
          url: media.url,
          mimeType: media.mimeType,
          byteSize: media.byteSize,
          originalFilename: media.originalFilename,
          createdAt: media.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
