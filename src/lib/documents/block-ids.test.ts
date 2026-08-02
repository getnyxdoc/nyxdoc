import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type NyxDatabase } from "@/lib/db/client";
import { runAppMigrations } from "@/lib/db/migrations";
import { createDocument, getDocument, patchDocument } from "@/lib/documents/service";
import { normalizeTopLevelBlockIds } from "@/lib/documents/block-ids";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";
import { createWorkspaceToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function content(blocks: Array<{ id: string; text: string }>) {
  return {
    schemaVersion: 2 as const,
    blocks: blocks.map((block) => ({
      id: block.id,
      type: "p" as const,
      children: [{ text: block.text }],
    })),
  } satisfies NyxdocDocumentV2;
}

function createPersistentTestDatabase(databasePath: string) {
  const database = openDatabase(databasePath);
  database.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 1,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  runAppMigrations(database);
  return database;
}

describe("top-level block ID normalization", () => {
  it("returns deterministic path, requested ID, effective ID, and reason for every remap", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const actor = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    createDocument(database, workspace.id, actor, {
      title: "기존 블록 소유 문서",
      content: content([{ id: "owned-by-another-document", text: "이미 사용 중" }]),
    });

    const normalized = normalizeTopLevelBlockIds(database, randomUUID(), {
      schemaVersion: 2,
      blocks: [
        { id: "owned-by-another-document", type: "p", children: [{ text: "충돌" }] },
        { id: "same-document-id", type: "p", children: [{ text: "첫 번째" }] },
        { id: "same-document-id", type: "p", children: [{ text: "두 번째" }] },
        { type: "p", children: [{ text: "ID 없음" }] },
      ],
    } as unknown as NyxdocDocumentV2);

    expect(normalized.repairs).toMatchObject([
      {
        path: "/blocks/0/id",
        requestedId: "owned-by-another-document",
        reason: "cross_document_collision",
      },
      {
        path: "/blocks/2/id",
        requestedId: "same-document-id",
        reason: "duplicate_in_document",
      },
      {
        path: "/blocks/3/id",
        requestedId: null,
        reason: "missing",
      },
    ]);
    expect(normalized.repairs.map((remap) => remap.effectiveId)).toEqual(
      normalized.content.blocks
        .filter((_, index) => [0, 2, 3].includes(index))
        .map((block) => block.id),
    );
  });

  it("persists the same remap for an idempotent replay after a database restart and accepts its effective ID in a follow-up patch", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "nyxdoc-block-id-contract-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nyxdoc.db");
    let database = createPersistentTestDatabase(databasePath);
    const { user, workspace } = createTestUser(database);
    const human = { type: "human" as const, userId: user.id, label: user.name, source: "web" as const };
    const credential = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Block ID contract agent",
    });
    const agent = {
      type: "agent" as const,
      userId: user.id,
      tokenId: credential.summary.id,
      label: "Block ID contract agent",
      source: "mcp" as const,
    };
    createDocument(database, workspace.id, human, {
      title: "기존 ID 소유자",
      content: content([{ id: "shared-public-id", text: "기존 문서" }]),
    });
    const request = {
      requestId: "block-id-replay-after-restart-001",
      title: "정규화 대상 문서",
      content: content([{ id: "shared-public-id", text: "새 문서" }]),
    };

    const created = createDocument(database, workspace.id, agent, request);
    expect(created.normalization).toMatchObject({
      identityScope: "documentId+nodeId",
      remappedTopLevelBlockIds: 1,
      remaps: [{
        path: "/blocks/0/id",
        requestedId: "shared-public-id",
        reason: "cross_document_collision",
      }],
    });
    const effectiveId = created.normalization!.remaps[0].effectiveId;

    const patched = patchDocument(database, workspace.id, agent, created.document.id, {
      baseRevision: 1,
      requestId: "block-id-effective-id-follow-up-001",
      operations: [{
        op: "replace_block",
        blockId: effectiveId,
        block: { type: "p", children: [{ text: "유효 ID로 후속 수정" }] },
      }],
    });
    expect(patched.document.revisionNumber).toBe(2);
    expect(getDocument(database, workspace.id, created.document.id).content.blocks[0]).toMatchObject({
      id: effectiveId,
      children: [{ text: "유효 ID로 후속 수정" }],
    });

    database.close();
    database = openDatabase(databasePath);
    databases.push(database);
    expect(createDocument(database, workspace.id, agent, request)).toEqual(created);
  });
});
