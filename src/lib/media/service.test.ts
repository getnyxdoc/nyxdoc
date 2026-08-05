import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import {
  getMediaAsset,
  MAX_MEDIA_BYTES,
  MediaServiceError,
  readMediaAsset,
  removeUnreferencedDiagnosticMedia,
  storeMediaAsset,
} from "@/lib/media/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const TRUNCATED_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const databases: NyxDatabase[] = [];
const mediaRoots: string[] = [];

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "nyxdoc-media-test-"));
  mediaRoots.push(mediaRoot);
  const { user, workspace } = createTestUser(database);
  return { database, mediaRoot, user, workspace };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (mediaRoots.length) {
    const mediaRoot = mediaRoots.pop();
    if (
      mediaRoot
      && path.dirname(mediaRoot) === path.resolve(os.tmpdir())
      && path.basename(mediaRoot).startsWith("nyxdoc-media-test-")
    ) {
      rmSync(mediaRoot, { force: true, recursive: true });
    }
  }
});

describe("workspace media storage", () => {
  it("stores binary bytes outside the document and returns an authenticated link", async () => {
    const { database, mediaRoot, user, workspace } = fixture();
    const media = await storeMediaAsset(
      database,
      {
        bytes: PNG_BYTES,
        originalFilename: "../../clipboard-shot.png",
        userId: user.id,
        workspaceId: workspace.id,
      },
      mediaRoot,
    );

    expect(media).toMatchObject({
      mimeType: "image/png",
      originalFilename: "clipboard-shot.png",
      purpose: "content",
      createdNew: true,
      url: `/api/media/${media.id}`,
    });
    expect(media.url).not.toContain("base64");
    expect(readFileSync(path.join(mediaRoot, media.storageKey))).toEqual(PNG_BYTES);
    expect(
      database
        .prepare("SELECT uploaded_by_user_id, byte_size FROM media_assets WHERE id = ?")
        .get(media.id),
    ).toEqual({ uploaded_by_user_id: user.id, byte_size: PNG_BYTES.length });
  });

  it("removes unreferenced diagnostic images from the database and filesystem", async () => {
    const { database, mediaRoot, user, workspace } = fixture();
    const media = await storeMediaAsset(database, {
      bytes: PNG_BYTES,
      originalFilename: "bug.png",
      purpose: "diagnostic",
      userId: user.id,
      workspaceId: workspace.id,
    }, mediaRoot);

    expect(existsSync(path.join(mediaRoot, media.storageKey))).toBe(true);
    await expect(removeUnreferencedDiagnosticMedia(database, [media.id], mediaRoot))
      .resolves.toEqual({ removed: 1, failedStorageKeys: [] });
    expect(database.prepare("SELECT id FROM media_assets WHERE id = ?").get(media.id))
      .toBeUndefined();
    expect(existsSync(path.join(mediaRoot, media.storageKey))).toBe(false);
  });

  it("deduplicates identical images per workspace and repairs a missing file", async () => {
    const { database, mediaRoot, user, workspace } = fixture();
    const input = { bytes: PNG_BYTES, userId: user.id, workspaceId: workspace.id };
    const first = await storeMediaAsset(database, input, mediaRoot);
    rmSync(path.join(mediaRoot, first.storageKey));

    const second = await storeMediaAsset(database, input, mediaRoot);
    expect(second.id).toBe(first.id);
    expect(readFileSync(path.join(mediaRoot, first.storageKey))).toEqual(PNG_BYTES);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM media_assets").get() as { count: number }).count,
    ).toBe(1);
  });

  it("isolates reads by workspace", async () => {
    const { database, mediaRoot, user, workspace } = fixture();
    const media = await storeMediaAsset(
      database,
      { bytes: PNG_BYTES, userId: user.id, workspaceId: workspace.id },
      mediaRoot,
    );
    const other = createTestUser(database, { name: "Other" });

    expect(() => getMediaAsset(database, other.workspace.id, media.id)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    await expect(readMediaAsset(database, workspace.id, media.id, mediaRoot)).resolves.toMatchObject({
      asset: { id: media.id },
    });
  });

  it("rejects unsupported content even when it is named like an image", async () => {
    const { database, mediaRoot, user, workspace } = fixture();
    await expect(
      storeMediaAsset(
        database,
        {
          bytes: Buffer.from("<svg onload=alert(1)></svg>"),
          originalFilename: "unsafe.png",
          userId: user.id,
          workspaceId: workspace.id,
        },
        mediaRoot,
      ),
    ).rejects.toBeInstanceOf(MediaServiceError);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM media_assets").get() as { count: number }).count,
    ).toBe(0);
  });

  it.each([
    ["PNG", TRUNCATED_PNG_BYTES],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
    ["GIF", Buffer.from("GIF89a", "ascii")],
    ["WebP", Buffer.from("RIFF\x08\x00\x00\x00WEBP", "binary")],
  ])("rejects truncated %s payloads that only contain a valid signature", async (_format, bytes) => {
    const { database, mediaRoot, user, workspace } = fixture();
    await expect(storeMediaAsset(
      database,
      { bytes, userId: user.id, workspaceId: workspace.id },
      mediaRoot,
    )).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM media_assets").get()).toEqual({ count: 0 });
  });

  it("rejects files larger than 15MB before writing", async () => {
    const { database, mediaRoot, user, workspace } = fixture();
    const oversized = Buffer.alloc(MAX_MEDIA_BYTES + 1);
    PNG_BYTES.copy(oversized);

    await expect(
      storeMediaAsset(
        database,
        { bytes: oversized, userId: user.id, workspaceId: workspace.id },
        mediaRoot,
      ),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
});
