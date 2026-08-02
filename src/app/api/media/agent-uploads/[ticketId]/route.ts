import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { consumeAgentMediaUploadTicket } from "@/lib/media/upload-tickets";
import { MAX_MEDIA_BYTES, MediaServiceError } from "@/lib/media/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBodyWithLimit(request: Request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel();
      throw new MediaServiceError("TOO_LARGE", "이미지는 15MB 이하만 업로드할 수 있습니다.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ ticketId: string }> },
) {
  try {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
      throw new MediaServiceError("TOO_LARGE", "이미지는 15MB 이하만 업로드할 수 있습니다.");
    }
    const { ticketId } = await context.params;
    const result = await consumeAgentMediaUploadTicket(sqlite, {
      ticketId,
      authorization: request.headers.get("authorization"),
      bytes: await readBodyWithLimit(request),
    });
    return Response.json(
      {
        media: {
          id: result.media.id,
          url: result.media.url,
          mimeType: result.media.mimeType,
          byteSize: result.media.byteSize,
          sha256: result.media.sha256,
          originalFilename: result.media.originalFilename,
          createdAt: result.media.createdAt,
        },
        documentId: result.documentId,
        imageBlock: result.imageBlock,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = await apiErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
