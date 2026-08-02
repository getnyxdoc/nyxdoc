import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import {
  consumeAgentMediaUploadTicket,
  createAgentMediaUploadTicket,
} from "@/lib/media/upload-tickets";
import { authenticateApiToken, createWorkspaceToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const databases: NyxDatabase[] = [];
const mediaRoots: string[] = [];

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "nyxdoc-agent-upload-test-"));
  mediaRoots.push(mediaRoot);
  const { user, workspace } = createTestUser(database);
  const credential = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Image Agent",
    role: "editor",
    scopes: ["documents:read", "documents:write", "documents:commit", "changes:read"],
  });
  const identity = authenticateApiToken(database, `Bearer ${credential.token}`);
  const document = createDocument(database, workspace.id, {
    type: "human",
    userId: user.id,
    label: user.name,
    source: "web",
  }, {
    title: "이미지 문서",
    content: {
      schemaVersion: 2,
      blocks: [{ id: "body", type: "p", children: [{ text: "본문" }] }],
    },
  }).document;
  return { database, mediaRoot, user, workspace, credential, identity, document };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (mediaRoots.length) {
    const mediaRoot = mediaRoots.pop();
    if (
      mediaRoot
      && path.dirname(mediaRoot) === path.resolve(os.tmpdir())
      && path.basename(mediaRoot).startsWith("nyxdoc-agent-upload-test-")
    ) {
      rmSync(mediaRoot, { force: true, recursive: true });
    }
  }
});

describe("agent image upload tickets", () => {
  it("uploads raw bytes once, binds them to the document, and returns a ready image block", async () => {
    const { database, mediaRoot, identity, document } = fixture();
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");
    const ticket = createAgentMediaUploadTicket(database, identity, {
      documentId: document.id,
      filename: "../../capture.png",
      mimeType: "image/png",
      byteSize: PNG_BYTES.length,
      sha256,
      alt: "테스트 캡처",
    });

    expect(ticket.authorization).toMatch(/^NyxUpload nyx_upload_/);
    expect(ticket.path).toBe(`/api/media/agent-uploads/${ticket.id}`);
    const uploaded = await consumeAgentMediaUploadTicket(database, {
      ticketId: ticket.id,
      authorization: ticket.authorization,
      bytes: PNG_BYTES,
    }, { mediaRoot });

    expect(uploaded.media).toMatchObject({
      workspaceId: identity.workspaceId,
      mimeType: "image/png",
      originalFilename: "capture.png",
      sha256,
    });
    expect(uploaded.imageBlock).toEqual({
      id: expect.any(String),
      type: "img",
      mediaId: uploaded.media.id,
      url: `/api/media/${uploaded.media.id}`,
      alt: "테스트 캡처",
      name: "capture.png",
      children: [{ text: "" }],
    });
    expect(database.prepare(
      `SELECT 1 FROM document_media_bindings
       WHERE document_id = ? AND media_id = ?`,
    ).get(document.id, uploaded.media.id)).toBeTruthy();

    await expect(consumeAgentMediaUploadTicket(database, {
      ticketId: ticket.id,
      authorization: ticket.authorization,
      bytes: PNG_BYTES,
    }, { mediaRoot })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects expired, forged, and cross-workspace uploads", async () => {
    const { database, mediaRoot, identity } = fixture();
    const issuedAt = new Date("2026-07-22T01:00:00.000Z");
    const ticket = createAgentMediaUploadTicket(database, identity, {
      filename: "capture.png",
    }, { now: issuedAt, ttlSeconds: 5 });

    await expect(consumeAgentMediaUploadTicket(database, {
      ticketId: ticket.id,
      authorization: "NyxUpload forged",
      bytes: PNG_BYTES,
    }, { mediaRoot, now: issuedAt })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(consumeAgentMediaUploadTicket(database, {
      ticketId: ticket.id,
      authorization: ticket.authorization,
      bytes: PNG_BYTES,
    }, { mediaRoot, now: new Date(issuedAt.getTime() + 6_000) }))
      .rejects.toMatchObject({ code: "EXPIRED" });

    const other = createTestUser(database, { name: "Other" });
    const otherDocument = createDocument(database, other.workspace.id, {
      type: "human",
      userId: other.user.id,
      label: other.user.name,
      source: "web",
    }, {
      title: "다른 문서",
      content: {
        schemaVersion: 2,
        blocks: [{ id: "other", type: "p", children: [{ text: "다른 본문" }] }],
      },
    }).document;
    expect(() => createAgentMediaUploadTicket(database, identity, {
      documentId: otherDocument.id,
      filename: "cross.png",
    })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("consumes a ticket on a mismatched payload and honors current permission revocation", async () => {
    const { database, mediaRoot, identity } = fixture();
    const mismatch = createAgentMediaUploadTicket(database, identity, {
      filename: "capture.png",
      mimeType: "image/jpeg",
    });
    await expect(consumeAgentMediaUploadTicket(database, {
      ticketId: mismatch.id,
      authorization: mismatch.authorization,
      bytes: PNG_BYTES,
    }, { mediaRoot })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(consumeAgentMediaUploadTicket(database, {
      ticketId: mismatch.id,
      authorization: mismatch.authorization,
      bytes: PNG_BYTES,
    }, { mediaRoot })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM media_assets").get())
      .toEqual({ count: 0 });

    const revoked = createAgentMediaUploadTicket(database, identity, {
      filename: "revoked.png",
    });
    database.prepare(
      "UPDATE workspace_agents SET permission_deny_json = '[\"media.upload\"]' WHERE id = ?",
    ).run(identity.agentId);
    await expect(consumeAgentMediaUploadTicket(database, {
      ticketId: revoked.id,
      authorization: revoked.authorization,
      bytes: PNG_BYTES,
    }, { mediaRoot })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
