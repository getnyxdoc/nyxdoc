import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getMediaRoot } from "@/lib/config";
import type { NyxDatabase } from "@/lib/db/client";

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
export const MAX_MEDIA_PIXELS = 40_000_000;
export const MAX_MEDIA_FRAMES = 200;
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageMimeType = typeof SUPPORTED_IMAGE_MIME_TYPES[number];

const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupportedImage = {
  extension: "gif" | "jpg" | "png" | "webp";
  mimeType: SupportedImageMimeType;
};

type MediaAssetRow = {
  byte_size: number;
  created_at: string;
  id: string;
  mime_type: MediaAsset["mimeType"];
  original_filename: string | null;
  sha256: string;
  storage_key: string;
  workspace_id: string;
};

export type MediaAsset = {
  byteSize: number;
  createdAt: string;
  id: string;
  mimeType: SupportedImage["mimeType"];
  originalFilename: string | null;
  sha256: string;
  storageKey: string;
  url: string;
  workspaceId: string;
};

export class MediaServiceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "UNAUTHORIZED"
      | "EXPIRED"
      | "CONFLICT"
      | "TOO_LARGE"
      | "UNSUPPORTED_TYPE",
    message: string,
  ) {
    super(message);
    this.name = "MediaServiceError";
  }
}

function startsWith(bytes: Buffer, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function detectImage(bytes: Buffer): SupportedImage | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  const gifHeader = bytes.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { extension: "gif", mimeType: "image/gif" };
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  return null;
}

async function validateDecodedImage(bytes: Buffer, detected: SupportedImage) {
  try {
    const options = {
      animated: true,
      failOn: "warning" as const,
      limitInputPixels: MAX_MEDIA_PIXELS,
      sequentialRead: true,
      unlimited: false,
    };
    const metadata = await sharp(bytes, options).metadata();
    const expectedFormat = detected.extension === "jpg" ? "jpeg" : detected.extension;
    const pages = metadata.pages ?? 1;
    const frameHeight = metadata.pageHeight ?? metadata.height ?? 0;
    const width = metadata.width ?? 0;
    const totalPixels = width * frameHeight * pages;
    if (
      metadata.format !== expectedFormat
      || width < 1
      || frameHeight < 1
      || pages < 1
      || pages > MAX_MEDIA_FRAMES
      || totalPixels > MAX_MEDIA_PIXELS
    ) {
      throw new MediaServiceError("INVALID_INPUT", "이미지 크기나 프레임 수가 허용 범위를 벗어났습니다.");
    }

    // metadata() only reads headers. Force a complete decode before any bytes
    // are hashed or persisted so truncated/corrupt images cannot enter storage.
    await sharp(bytes, options).toBuffer();
  } catch (error) {
    if (error instanceof MediaServiceError) throw error;
    throw new MediaServiceError("INVALID_INPUT", "손상되었거나 안전하게 해석할 수 없는 이미지입니다.");
  }
}

function normalizeFilename(value: string | undefined) {
  if (!value) return null;
  const normalized = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized ? normalized.slice(0, 255) : null;
}

function assetFromRow(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    storageKey: row.storage_key,
    sha256: row.sha256,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    originalFilename: row.original_filename,
    createdAt: row.created_at,
    url: `/api/media/${row.id}`,
  };
}

function assetPath(mediaRoot: string, storageKey: string) {
  const root = path.resolve(mediaRoot);
  const destination = path.resolve(root, storageKey);
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MediaServiceError("NOT_FOUND", "이미지 파일을 찾을 수 없습니다.");
  }
  return destination;
}

function findAssetByHash(database: NyxDatabase, workspaceId: string, sha256: string) {
  return database
    .prepare(
      `SELECT id, workspace_id, storage_key, sha256, mime_type, byte_size,
              original_filename, created_at
       FROM media_assets
       WHERE workspace_id = ? AND sha256 = ?`,
    )
    .get(workspaceId, sha256) as MediaAssetRow | undefined;
}

async function writeAtomically(destination: string, bytes: Buffer) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ensureStoredFile(mediaRoot: string, row: MediaAssetRow, bytes: Buffer) {
  const destination = assetPath(mediaRoot, row.storage_key);
  try {
    await access(destination);
  } catch {
    await writeAtomically(destination, bytes);
  }
}

export async function storeMediaAsset(
  database: NyxDatabase,
  input: {
    bytes: ArrayBuffer | Uint8Array;
    originalFilename?: string;
    expectedByteSize?: number;
    expectedMimeType?: SupportedImageMimeType;
    expectedSha256?: string;
    tokenId?: string;
    userId: string;
    workspaceId: string;
  },
  mediaRoot = getMediaRoot(),
) {
  const bytes = Buffer.from(
    input.bytes instanceof ArrayBuffer
      ? input.bytes
      : input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength),
  );
  if (bytes.length === 0) {
    throw new MediaServiceError("INVALID_INPUT", "붙여넣은 이미지가 비어 있습니다.");
  }
  if (bytes.length > MAX_MEDIA_BYTES) {
    throw new MediaServiceError("TOO_LARGE", "이미지는 15MB 이하만 업로드할 수 있습니다.");
  }
  if (input.expectedByteSize !== undefined && bytes.length !== input.expectedByteSize) {
    throw new MediaServiceError("INVALID_INPUT", "업로드한 이미지의 크기가 발급 요청과 일치하지 않습니다.");
  }

  const image = detectImage(bytes);
  if (!image) {
    throw new MediaServiceError(
      "UNSUPPORTED_TYPE",
      "PNG, JPEG, GIF, WebP 이미지만 업로드할 수 있습니다.",
    );
  }
  if (input.expectedMimeType && image.mimeType !== input.expectedMimeType) {
    throw new MediaServiceError("INVALID_INPUT", "업로드한 이미지 형식이 발급 요청과 일치하지 않습니다.");
  }
  await validateDecodedImage(bytes, image);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.expectedSha256 && sha256 !== input.expectedSha256.toLowerCase()) {
    throw new MediaServiceError("INVALID_INPUT", "업로드한 이미지 해시가 발급 요청과 일치하지 않습니다.");
  }
  const existing = findAssetByHash(database, input.workspaceId, sha256);
  if (existing) {
    await ensureStoredFile(mediaRoot, existing, bytes);
    return assetFromRow(existing);
  }

  const id = randomUUID();
  const storageKey = `${sha256.slice(0, 2)}/${id}.${image.extension}`;
  const destination = assetPath(mediaRoot, storageKey);
  const createdAt = new Date().toISOString();
  await writeAtomically(destination, bytes);

  try {
    const legacyTokenId = input.tokenId && database.prepare(
      "SELECT id FROM workspace_api_tokens WHERE id = ?",
    ).get(input.tokenId) ? input.tokenId : null;
    database
      .prepare(
        `INSERT INTO media_assets
         (id, workspace_id, storage_key, sha256, mime_type, byte_size,
          original_filename, uploaded_by_user_id, uploaded_by_token_id,
          uploaded_by_credential_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        storageKey,
        sha256,
        image.mimeType,
        bytes.length,
        normalizeFilename(input.originalFilename),
        input.userId,
        legacyTokenId,
        input.tokenId ?? null,
        createdAt,
      );
  } catch (error) {
    await rm(destination, { force: true });
    const raced = findAssetByHash(database, input.workspaceId, sha256);
    if (raced) {
      await ensureStoredFile(mediaRoot, raced, bytes);
      return assetFromRow(raced);
    }
    throw error;
  }

  return {
    id,
    workspaceId: input.workspaceId,
    storageKey,
    sha256,
    mimeType: image.mimeType,
    byteSize: bytes.length,
    originalFilename: normalizeFilename(input.originalFilename),
    createdAt,
    url: `/api/media/${id}`,
  } satisfies MediaAsset;
}

export function getMediaAsset(
  database: NyxDatabase,
  workspaceId: string,
  mediaId: string,
) {
  if (!MEDIA_ID_PATTERN.test(mediaId)) {
    throw new MediaServiceError("NOT_FOUND", "이미지를 찾을 수 없습니다.");
  }
  const row = database
    .prepare(
      `SELECT id, workspace_id, storage_key, sha256, mime_type, byte_size,
              original_filename, created_at
       FROM media_assets
       WHERE id = ? AND workspace_id = ?`,
    )
    .get(mediaId, workspaceId) as MediaAssetRow | undefined;
  if (!row) throw new MediaServiceError("NOT_FOUND", "이미지를 찾을 수 없습니다.");
  return assetFromRow(row);
}

export async function readMediaAsset(
  database: NyxDatabase,
  workspaceId: string,
  mediaId: string,
  mediaRoot = getMediaRoot(),
) {
  const asset = getMediaAsset(database, workspaceId, mediaId);
  try {
    return { asset, bytes: await readFile(assetPath(mediaRoot, asset.storageKey)) };
  } catch (error) {
    if (error instanceof MediaServiceError) throw error;
    throw new MediaServiceError("NOT_FOUND", "이미지 파일을 찾을 수 없습니다.");
  }
}

export async function removeMediaStorageKeys(
  storageKeys: string[],
  mediaRoot = getMediaRoot(),
) {
  const removed: string[] = [];
  const failed: Array<{ storageKey: string; error: string }> = [];
  for (const storageKey of storageKeys) {
    try {
      await rm(assetPath(mediaRoot, storageKey), { force: true });
      removed.push(storageKey);
    } catch (error) {
      failed.push({
        storageKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { removed, failed };
}
