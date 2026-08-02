import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { assertDatabaseIntegrity } from "@/lib/db/integrity";
import { createDocument } from "@/lib/documents/service";
import { setDocumentHumanGrant } from "@/lib/sharing/access";
import {
  enableDocumentPublicShare,
  getPublicSharedDocument,
} from "@/lib/sharing/service";
import { authenticateApiToken, createWorkspaceToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";
import { createWorkspace } from "@/lib/workspaces/service";
import {
  applyWorkspaceTreeTransfer,
  archiveWorkspaceAgentHistory,
  planWorkspaceAgentHistoryArchive,
  planWorkspaceTreeTransfer,
} from "@/lib/workspaces/transfer";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace: source } = createTestUser(database);
  const target = createWorkspace(database, user, "gameroom");
  return { database, user, source, target };
}

describe("workspace tree transfer", () => {
  it("moves one canonical document tree, its agent identity, credential, and media without rewriting history", () => {
    const { database, user, source, target } = fixture();
    const credential = createWorkspaceToken(database, {
      workspaceId: source.id,
      userId: user.id,
      name: "gameroom",
      role: "editor",
    });
    const mediaId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size, original_filename,
        uploaded_by_user_id, uploaded_by_token_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 128, 'agent.png', NULL, ?, ?)`,
    ).run(
      mediaId,
      source.id,
      `test/${mediaId}.png`,
      "a".repeat(64),
      credential.summary.id,
      createdAt,
    );
    database.prepare("UPDATE workspace_agents SET avatar_media_id = ? WHERE id = ?")
      .run(mediaId, credential.summary.agentId);

    const human = {
      type: "human" as const,
      userId: user.id,
      principalId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const root = createDocument(database, source.id, human, {
      title: "gameroom",
      content: {
        schemaVersion: 2,
        blocks: [{ id: randomUUID(), type: "h1", children: [{ text: "정본" }] }],
      },
    });
    const agent = {
      type: "agent" as const,
      userId: user.id,
      tokenId: credential.summary.id,
      principalId: credential.summary.agentId,
      avatarMediaId: mediaId,
      label: "gameroom",
      source: "mcp" as const,
    };
    const child = createDocument(database, source.id, agent, {
      requestId: "transfer-fixture-child",
      title: "운영",
      parentDocumentId: root.document.id,
      content: {
        schemaVersion: 2,
        blocks: [{
          id: randomUUID(),
          type: "p",
          children: [{ text: "상위 문서: " }, {
            type: "doc_ref",
            documentId: root.document.id,
            children: [{ text: "gameroom" }],
          }],
        }, {
          id: randomUUID(),
          type: "img",
          mediaId,
          url: `/api/media/${mediaId}`,
          children: [{ text: "" }],
        }],
      },
    });
    const recipient = createTestUser(database, {
      name: "Shared recipient",
      email: "shared-recipient@example.com",
    });
    setDocumentHumanGrant(database, {
      workspaceId: source.id,
      documentId: child.document.id,
      recipientUserId: recipient.user.id,
      role: "editor",
      actorUserId: user.id,
      actorLabel: user.name,
    });
    const publicShare = enableDocumentPublicShare(database, {
      workspaceId: source.id,
      documentId: root.document.id,
      userId: user.id,
      actorLabel: user.name,
    });
    database.prepare(
      `INSERT INTO agent_document_assignments
       (id, workspace_id, agent_id, document_id, assignment_type, status, note,
        assigned_by_user_id, assigned_by_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'owner', 'active', NULL, ?, NULL, ?, ?)`,
    ).run(
      randomUUID(),
      source.id,
      credential.summary.agentId,
      child.document.id,
      user.id,
      createdAt,
      createdAt,
    );

    const beforeDocuments = database.prepare(
      `SELECT id, created_at, updated_at FROM documents WHERE id IN (?, ?) ORDER BY id`,
    ).all(root.document.id, child.document.id);
    const beforeRevisions = database.prepare(
      `SELECT id, document_id, revision_number, snapshot_json, created_at
       FROM document_revisions WHERE document_id IN (?, ?) ORDER BY id`,
    ).all(root.document.id, child.document.id);
    const beforeAgent = database.prepare(
      "SELECT created_at, updated_at FROM workspace_agents WHERE id = ?",
    ).get(credential.summary.agentId);

    const input = {
      sourceWorkspaceId: source.id,
      targetWorkspaceId: target.id,
      rootDocumentId: root.document.id,
      agentId: credential.summary.agentId,
    };
    expect(planWorkspaceTreeTransfer(database, input)).toMatchObject({
      status: "ready",
      counts: {
        documents: 2,
        blocks: 3,
        revisions: 2,
        events: 2,
        internalReferences: 1,
        media: 1,
        credentials: 1,
        writeReceipts: 1,
      },
      blockers: [],
    });

    const applied = applyWorkspaceTreeTransfer(database, input);
    expect(applied.status).toBe("already_applied");
    expect(applied.counts.documents).toBe(2);
    expect(applied.counts.writeReceipts).toBe(1);
    expect(assertDatabaseIntegrity(database)).toEqual({
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      tenantBoundaryViolations: 0,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ? AND id IN (?, ?)",
    ).get(target.id, root.document.id, child.document.id)).toEqual({ count: 2 });
    expect(database.prepare(
      "SELECT workspace_id FROM workspace_agents WHERE id = ?",
    ).get(credential.summary.agentId)).toEqual({ workspace_id: target.id });
    expect(database.prepare(
      "SELECT workspace_id FROM workspace_api_tokens WHERE id = ?",
    ).get(credential.summary.id)).toEqual({ workspace_id: target.id });
    expect(database.prepare(
      "SELECT workspace_id, uploaded_by_token_id FROM media_assets WHERE id = ?",
    ).get(mediaId)).toEqual({
      workspace_id: target.id,
      uploaded_by_token_id: credential.summary.id,
    });
    expect(authenticateApiToken(database, `Bearer ${credential.token}`).workspaceId).toBe(target.id);
    expect(database.prepare(
      `SELECT workspace_id FROM agent_document_assignments
       WHERE agent_id = ? AND document_id = ?`,
    ).get(credential.summary.agentId, child.document.id)).toEqual({ workspace_id: target.id });
    expect(database.prepare(
      "SELECT workspace_id FROM document_media_bindings WHERE document_id = ? AND media_id = ?",
    ).get(child.document.id, mediaId)).toEqual({ workspace_id: target.id });
    expect(database.prepare(
      "SELECT workspace_id, role FROM document_human_grants WHERE document_id = ? AND user_id = ?",
    ).get(child.document.id, recipient.user.id)).toEqual({
      workspace_id: target.id,
      role: "editor",
    });
    expect(database.prepare(
      "SELECT workspace_id FROM document_public_shares WHERE document_id = ?",
    ).get(root.document.id)).toEqual({ workspace_id: target.id });
    expect(getPublicSharedDocument(database, publicShare.publicToken).workspace.id).toBe(target.id);
    expect(database.prepare(
      `SELECT id, created_at, updated_at FROM documents WHERE id IN (?, ?) ORDER BY id`,
    ).all(root.document.id, child.document.id)).toEqual(beforeDocuments);
    expect(database.prepare(
      `SELECT id, document_id, revision_number, snapshot_json, created_at
       FROM document_revisions WHERE document_id IN (?, ?) ORDER BY id`,
    ).all(root.document.id, child.document.id)).toEqual(beforeRevisions);
    expect(database.prepare(
      "SELECT created_at, updated_at FROM workspace_agents WHERE id = ?",
    ).get(credential.summary.agentId)).toEqual(beforeAgent);
    expect(planWorkspaceTreeTransfer(database, input).status).toBe("already_applied");
  });

  it("blocks a credential whose document boundary would remain in the source workspace", () => {
    const { database, user, source, target } = fixture();
    const human = {
      type: "human" as const,
      userId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const outside = createDocument(database, source.id, human, {
      title: "남겨둘 문서",
      content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "p", children: [{ text: "source" }] }] },
    });
    const root = createDocument(database, source.id, human, {
      title: "옮길 문서",
      content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "p", children: [{ text: "target" }] }] },
    });
    const credential = createWorkspaceToken(database, {
      workspaceId: source.id,
      userId: user.id,
      name: "범위 제한 에이전트",
      role: "viewer",
      rootDocumentId: outside.document.id,
    });

    const plan = planWorkspaceTreeTransfer(database, {
      sourceWorkspaceId: source.id,
      targetWorkspaceId: target.id,
      rootDocumentId: root.document.id,
      agentId: credential.summary.agentId,
    });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContain(
      `연결 키 ${credential.summary.id}의 문서 범위가 이전 트리 밖을 가리킵니다.`,
    );
  });

  it("preserves archived QA provenance under a disabled source agent before moving the live agent", () => {
    const { database, user, source, target } = fixture();
    const credential = createWorkspaceToken(database, {
      workspaceId: source.id,
      userId: user.id,
      name: "gameroom",
      role: "editor",
    });
    const human = {
      type: "human" as const,
      userId: user.id,
      label: user.name,
      source: "web" as const,
    };
    const root = createDocument(database, source.id, human, {
      title: "gameroom",
      content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "h1", children: [{ text: "정본" }] }] },
    });
    const actor = {
      type: "agent" as const,
      userId: user.id,
      tokenId: credential.summary.id,
      principalId: credential.summary.agentId,
      label: "gameroom",
      source: "mcp" as const,
    };
    createDocument(database, source.id, actor, {
      requestId: "canonical-child",
      title: "운영",
      parentDocumentId: root.document.id,
      content: { schemaVersion: 2, blocks: [{ id: randomUUID(), type: "p", children: [{ text: "정본 기록" }] }] },
    });
    const qaMediaId = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size, original_filename,
        uploaded_by_user_id, uploaded_by_token_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 68, 'qa.png', NULL, ?, ?)`,
    ).run(
      qaMediaId,
      source.id,
      `qa/${qaMediaId}.png`,
      "b".repeat(64),
      credential.summary.id,
      createdAt,
    );
    const qa = createDocument(database, source.id, actor, {
      requestId: "archived-qa-document",
      title: "QA-ARCHIVED",
      content: {
        schemaVersion: 2,
        blocks: [{
          id: randomUUID(),
          type: "img",
          mediaId: qaMediaId,
          url: `/api/media/${qaMediaId}`,
          children: [{ text: "" }],
        }],
      },
    });
    database.prepare(
      "UPDATE documents SET status = 'archived', lifecycle_state = 'archived' WHERE id = ?",
    ).run(qa.document.id);

    const historyInput = {
      sourceWorkspaceId: source.id,
      rootDocumentId: root.document.id,
      agentId: credential.summary.agentId,
      displayName: "gameroom QA archive",
    };
    expect(planWorkspaceAgentHistoryArchive(database, historyInput)).toEqual({
      status: "ready",
      counts: { documents: 1, revisions: 1, events: 1, writeReceipts: 1, media: 1 },
      blockers: [],
    });
    expect(planWorkspaceTreeTransfer(database, {
      sourceWorkspaceId: source.id,
      targetWorkspaceId: target.id,
      rootDocumentId: root.document.id,
      agentId: credential.summary.agentId,
    }).status).toBe("blocked");

    const archived = archiveWorkspaceAgentHistory(database, historyInput);
    expect(archived.archiveAgentId).toEqual(expect.any(String));
    expect(archived.archiveCredentialId).toEqual(expect.any(String));
    expect(database.prepare(
      "SELECT workspace_id, status, role FROM workspace_agents WHERE id = ?",
    ).get(archived.archiveAgentId)).toEqual({
      workspace_id: source.id,
      status: "disabled",
      role: "viewer",
    });
    expect(database.prepare(
      "SELECT workspace_id, revoked_at FROM workspace_api_tokens WHERE id = ?",
    ).get(archived.archiveCredentialId)).toEqual({
      workspace_id: source.id,
      revoked_at: expect.any(String),
    });
    expect(database.prepare(
      "SELECT actor_principal_id, actor_token_id FROM document_revisions WHERE document_id = ?",
    ).get(qa.document.id)).toEqual({
      actor_principal_id: archived.archiveAgentId,
      actor_token_id: archived.archiveCredentialId,
    });
    expect(database.prepare(
      "SELECT token_id FROM agent_write_requests WHERE request_id = 'archived-qa-document'",
    ).get()).toEqual({ token_id: archived.archiveCredentialId });
    expect(database.prepare(
      "SELECT uploaded_by_token_id FROM media_assets WHERE id = ?",
    ).get(qaMediaId)).toEqual({ uploaded_by_token_id: archived.archiveCredentialId });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_write_requests WHERE token_id = ?",
    ).get(credential.summary.id)).toEqual({ count: 1 });
    expect(planWorkspaceAgentHistoryArchive(database, historyInput).status).toBe("not_needed");

    const transferInput = {
      sourceWorkspaceId: source.id,
      targetWorkspaceId: target.id,
      rootDocumentId: root.document.id,
      agentId: credential.summary.agentId,
    };
    expect(planWorkspaceTreeTransfer(database, transferInput)).toMatchObject({
      status: "ready",
      counts: { documents: 2, credentials: 1, writeReceipts: 1, media: 0 },
    });
    applyWorkspaceTreeTransfer(database, transferInput);
    expect(authenticateApiToken(database, `Bearer ${credential.token}`).workspaceId).toBe(target.id);
    expect(assertDatabaseIntegrity(database).tenantBoundaryViolations).toBe(0);
  });
});
