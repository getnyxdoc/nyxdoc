import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { updateDocument } from "@/lib/documents/service";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";
import {
  acceptOrganizationInvitation,
  addOrganizationTeamMember,
  createOrganization,
  createOrganizationInvitation,
  createOrganizationTeam,
  upsertOrganizationWorkspaceTeamGrant,
} from "@/lib/organizations/service";
import {
  listDocumentHumanAccess,
  listDocumentShareCandidates,
  listHumanGrantedDocuments,
  revokeDocumentHumanGrant,
  setDocumentHumanGrant,
} from "@/lib/sharing/access";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("document human sharing", () => {
  it("grants, updates and revokes one document without adding workspace membership", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database, {
      name: "Owner",
      email: "owner@example.com",
    });
    const recipient = createTestUser(database, {
      name: "Recipient",
      email: "recipient@example.com",
    });
    const document = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(owner.workspace.id) as { id: string };
    const historicalMediaId = randomUUID();
    const currentMediaId = randomUUID();
    const now = new Date().toISOString();
    const insertMedia = database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size,
        original_filename, uploaded_by_user_id, uploaded_by_token_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 1, ?, ?, NULL, ?)`,
    );
    insertMedia.run(
      historicalMediaId,
      owner.workspace.id,
      `${historicalMediaId}.png`,
      `sha-${historicalMediaId}`,
      "historical.png",
      owner.user.id,
      now,
    );
    insertMedia.run(
      currentMediaId,
      owner.workspace.id,
      `${currentMediaId}.png`,
      `sha-${currentMediaId}`,
      "current.png",
      owner.user.id,
      now,
    );
    const actor = {
      type: "human" as const,
      userId: owner.user.id,
      label: owner.user.name,
      source: "web" as const,
    };
    const imageContent = (mediaId: string, id: string): NyxdocDocumentV2 => ({
      schemaVersion: 2 as const,
      blocks: [{
        id,
        type: "img" as const,
        mediaId,
        url: `/api/media/${mediaId}`,
        children: [{ text: "" }],
      }],
    });
    updateDocument(database, owner.workspace.id, actor, document.id, {
      baseRevision: 1,
      content: imageContent(historicalMediaId, "historical-image"),
    });
    updateDocument(database, owner.workspace.id, actor, document.id, {
      baseRevision: 2,
      content: imageContent(currentMediaId, "current-image"),
    });
    database.prepare("DELETE FROM document_media_bindings WHERE document_id = ?").run(document.id);

    expect(listDocumentShareCandidates(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      currentUserId: owner.user.id,
      query: "recipient",
    })).toEqual([{
      userId: recipient.user.id,
      name: recipient.user.name,
      email: recipient.user.email,
    }]);

    expect(setDocumentHumanGrant(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      recipientUserId: recipient.user.id,
      role: "viewer",
      actorUserId: owner.user.id,
      actorLabel: owner.user.name,
    })).toMatchObject({
      userId: recipient.user.id,
      role: "viewer",
      source: "document_grant",
    });
    expect(database.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).get(owner.workspace.id, recipient.user.id)).toBeUndefined();
    expect(database.prepare(
      `SELECT media_id
       FROM document_media_bindings
       WHERE document_id = ?
       ORDER BY media_id`,
    ).all(document.id)).toEqual(
      [historicalMediaId, currentMediaId]
        .sort()
        .map((mediaId) => ({ media_id: mediaId })),
    );
    expect(listHumanGrantedDocuments(
      database,
      owner.workspace.id,
      recipient.user.id,
    ).map((item) => item.id)).toEqual([document.id]);
    expect(listDocumentHumanAccess(
      database,
      owner.workspace.id,
      document.id,
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: owner.user.id,
        source: "workspace",
        role: "owner",
      }),
      expect.objectContaining({
        userId: recipient.user.id,
        source: "document_grant",
        role: "viewer",
      }),
    ]));

    setDocumentHumanGrant(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      recipientUserId: recipient.user.id,
      role: "editor",
      actorUserId: owner.user.id,
      actorLabel: owner.user.name,
    });
    expect(database.prepare(
      "SELECT role FROM document_human_grants WHERE document_id = ? AND user_id = ?",
    ).get(document.id, recipient.user.id)).toEqual({ role: "editor" });

    revokeDocumentHumanGrant(database, {
      workspaceId: owner.workspace.id,
      documentId: document.id,
      recipientUserId: recipient.user.id,
      actorUserId: owner.user.id,
      actorLabel: owner.user.name,
    });
    expect(listHumanGrantedDocuments(
      database,
      owner.workspace.id,
      recipient.user.id,
    )).toEqual([]);
  });

  it("treats team access as inherited and keeps organization shares inside the organization", () => {
    const database = createTestDatabase();
    databases.push(database);
    const owner = createTestUser(database, {
      name: "Organization owner",
      email: "organization-owner@example.com",
    });
    const teammate = createTestUser(database, {
      name: "Team member",
      email: "team-member@example.com",
    });
    const outsider = createTestUser(database, {
      name: "Outside user",
      email: "outside-user@example.com",
    });
    const organization = createOrganization(database, {
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Junglan Organization",
    });
    const workspace = createWorkspace(database, owner.user, "Organization docs", "en", {
      organizationId: organization.id,
    });
    const invitation = createOrganizationInvitation(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      email: teammate.user.email,
      role: "member",
    });
    acceptOrganizationInvitation(database, {
      token: invitation.token,
      user: teammate.user,
    });
    const team = createOrganizationTeam(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      name: "Documentation",
    });
    addOrganizationTeamMember(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      teamId: team.id,
      targetUserId: teammate.user.id,
    });
    upsertOrganizationWorkspaceTeamGrant(database, {
      organizationId: organization.id,
      userId: owner.user.id,
      actorLabel: owner.user.name,
      workspaceId: workspace.id,
      teamId: team.id,
      role: "editor",
    });
    const document = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? ORDER BY created_at LIMIT 1",
    ).get(workspace.id) as { id: string };

    expect(listDocumentHumanAccess(database, workspace.id, document.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: teammate.user.id,
          role: "editor",
          source: "workspace",
        }),
      ]),
    );
    expect(listDocumentShareCandidates(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      currentUserId: owner.user.id,
      query: "member",
    })).toEqual([]);
    expect(listDocumentShareCandidates(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      currentUserId: owner.user.id,
      query: "outside",
    })).toEqual([]);
    expect(() => setDocumentHumanGrant(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      recipientUserId: outsider.user.id,
      role: "viewer",
      actorUserId: owner.user.id,
      actorLabel: owner.user.name,
    })).toThrowError("조직 워크스페이스 문서는 해당 조직의 멤버에게만 공유할 수 있습니다.");
    expect(() => database.prepare(
      `INSERT INTO document_human_grants
       (id, workspace_id, document_id, user_id, role, created_by_user_id,
        created_by_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      workspace.id,
      document.id,
      outsider.user.id,
      owner.user.id,
      owner.user.name,
      new Date().toISOString(),
      new Date().toISOString(),
    )).toThrowError("document recipient must belong to the owning organization");
  });
});
