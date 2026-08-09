import { afterEach, describe, expect, it } from "vitest";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
} from "@/lib/collaboration/commands";
import {
  ensureCollaborationState,
  workingDocumentFromStoredState,
} from "@/lib/collaboration/drafts";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument, getDocument } from "@/lib/documents/service";
import {
  authenticateApiToken,
  createWorkspaceToken,
  tokenDocumentActor,
} from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const credential = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Race agent",
    role: "admin",
    scopes: ["documents:read", "documents:write", "documents:commit", "revisions:restore"],
  });
  const identity = authenticateApiToken(database, `Bearer ${credential.token}`);
  const actor = { ...tokenDocumentActor(identity, "mcp") };
  const document = createDocument(database, workspace.id, actor, {
    requestId: "authorization-race-document-001",
    title: "Authorization race",
    content: {
      schemaVersion: 2,
      blocks: [{ id: "initial", type: "p", children: [{ text: "initial" }] }],
    },
  }).document;
  const state = ensureCollaborationState(database, workspace.id, document.id);
  const commands = createCollaborationCommands({
    database,
    provider: createStoredCollaborationDocumentProvider(database),
  });
  return { database, workspace, identity, actor, document, state, commands };
}

describe("collaboration authorization TOCTOU boundary", () => {
  it("does not mutate the draft when an agent grant is downgraded after the public precheck", async () => {
    const value = fixture();
    const before = workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    );

    value.database.prepare(
      "UPDATE workspace_agents SET access_profile = 'reader', capabilities_json = ? WHERE id = ?",
    ).run(JSON.stringify(["documents.read"]), value.identity.agentId);

    await expect(value.commands.replaceWorking({
      roomName: value.state.roomName,
      actor: value.actor,
      expectedDraftVersion: before.draftVersion,
      requestId: "authorization-race-replace-001",
      replacement: {
        content: {
          schemaVersion: 2,
          blocks: [{ id: "forbidden", type: "p", children: [{ text: "forbidden" }] }],
        },
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    )).toEqual(before);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get("authorization-race-replace-001")).toEqual({ count: 0 });
  });

  it("keeps canonical and dirty draft unchanged when commit capability is revoked before commit", async () => {
    const value = fixture();
    const initial = workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    );
    const changed = await value.commands.replaceWorking({
      roomName: value.state.roomName,
      actor: value.actor,
      expectedDraftVersion: initial.draftVersion,
      requestId: "authorization-race-draft-001",
      replacement: {
        content: {
          schemaVersion: 2,
          blocks: [{ id: "dirty", type: "p", children: [{ text: "dirty" }] }],
        },
      },
    });
    const canonicalBefore = getDocument(
      value.database,
      value.workspace.id,
      value.document.id,
    );
    const draftBefore = workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    );

    value.database.prepare(
      "UPDATE workspace_agents SET access_profile = 'custom', capabilities_json = ? WHERE id = ?",
    ).run(
      JSON.stringify(["documents.read", "documents.update"]),
      value.identity.agentId,
    );

    await expect(value.commands.commitWorking({
      roomName: value.state.roomName,
      actor: value.actor,
      expectedDraftVersion: changed.workingDocument.draftVersion,
      requestId: "authorization-race-commit-001",
      summary: "must be denied",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(getDocument(
      value.database,
      value.workspace.id,
      value.document.id,
    )).toEqual(canonicalBefore);
    expect(workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    )).toEqual(draftBefore);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get("authorization-race-commit-001")).toEqual({ count: 0 });
  });

  it("keeps the dirty draft unchanged when revision restore is revoked before reset", async () => {
    const value = fixture();
    const initial = workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    );
    const changed = await value.commands.replaceWorking({
      roomName: value.state.roomName,
      actor: value.actor,
      expectedDraftVersion: initial.draftVersion,
      requestId: "authorization-race-restore-draft-001",
      replacement: {
        content: {
          schemaVersion: 2,
          blocks: [{ id: "dirty-restore", type: "p", children: [{ text: "dirty" }] }],
        },
      },
    });
    const canonical = getDocument(
      value.database,
      value.workspace.id,
      value.document.id,
    );
    const before = workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    );
    expect(canonical.revisionId).toBeTruthy();

    value.database.prepare(
      "UPDATE workspace_agents SET access_profile = 'custom', capabilities_json = ? WHERE id = ?",
    ).run(
      JSON.stringify(["documents.read", "documents.update", "documents.commit"]),
      value.identity.agentId,
    );

    await expect(value.commands.resetWorking({
      workspaceId: value.workspace.id,
      documentId: value.document.id,
      actor: value.actor,
      revisionId: canonical.revisionId!,
      expectedGeneration: changed.workingDocument.generation,
      expectedDraftVersion: changed.workingDocument.draftVersion,
      expectedBaseRevision: changed.workingDocument.baseRevisionNumber,
      requestId: "authorization-race-restore-001",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(workingDocumentFromStoredState(
      value.database,
      value.workspace.id,
      value.document.id,
    )).toEqual(before);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_idempotency_requests WHERE request_id = ?",
    ).get("authorization-race-restore-001")).toEqual({ count: 0 });
  });
});
