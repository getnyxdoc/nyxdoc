export type UploadedMedia = {
  byteSize: number;
  createdAt: string;
  id: string;
  mimeType: string;
  originalFilename: string | null;
  url: string;
};

export class MediaUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaUploadError";
  }
}

export async function uploadMediaFile(
  file: File,
  workspaceId?: string,
  documentId?: string,
): Promise<UploadedMedia> {
  const formData = new FormData();
  formData.append("file", file, file.name || "clipboard-image");

  const query = documentId
    ? `?${new URLSearchParams({ document: documentId }).toString()}`
    : "";
  const response = await fetch(`/api/media${query}`, {
    method: "POST",
    body: formData,
    credentials: "same-origin",
    ...(workspaceId ? { headers: { "x-nyxdoc-workspace-id": workspaceId } } : {}),
  });
  const payload = await response.json().catch(() => null) as
    | { error?: unknown; media?: Partial<UploadedMedia> }
    | null;
  if (!response.ok) {
    throw new MediaUploadError(
      typeof payload?.error === "string" ? payload.error : "이미지 업로드에 실패했습니다.",
    );
  }

  const media = payload?.media;
  if (
    !media
    || typeof media.id !== "string"
    || typeof media.url !== "string"
    || media.url !== `/api/media/${media.id}`
    || typeof media.mimeType !== "string"
    || typeof media.byteSize !== "number"
    || typeof media.createdAt !== "string"
  ) {
    throw new MediaUploadError("서버가 올바른 이미지 링크를 반환하지 않았습니다.");
  }

  return {
    id: media.id,
    url: media.url,
    mimeType: media.mimeType,
    byteSize: media.byteSize,
    createdAt: media.createdAt,
    originalFilename: typeof media.originalFilename === "string" ? media.originalFilename : null,
  };
}
