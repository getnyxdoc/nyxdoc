import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { createAssignmentSchema, savedViewQuerySchema } from "@/lib/collaboration/schemas";
import {
  assignDocument,
  createSavedView,
  listAssignmentHistory,
  listAssignments,
  listSavedViews,
  listWorkspaceAgents,
  runSavedView,
  updateAssignment,
} from "@/lib/collaboration/service";
import { queryDocuments } from "@/lib/documents/service";
import { createWorkspaceToken } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const document = database.prepare(
    "SELECT id, title FROM documents WHERE workspace_id = ? AND lifecycle_state = 'active' LIMIT 1",
  ).get(workspace.id) as { id: string; title: string };
  const first = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Gameroom",
    role: "editor",
  });
  const second = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Reviewer",
    role: "viewer",
    scopes: ["documents:read", "changes:read"],
  });
  return {
    database,
    user,
    workspace,
    document,
    first,
    second,
    actor: { type: "human" as const, userId: user.id, label: user.name },
  };
}

describe("workspace collaboration service", () => {
  it("keeps access identity separate from responsibility assignments", () => {
    const { database, workspace, document, first, second, actor } = fixture();

    const assignment = assignDocument(database, workspace.id, actor, {
      documentId: document.id,
      agentId: first.summary.agentId,
      assignmentType: "owner",
      note: "정본 운영 담당",
    });

    expect(assignment).toMatchObject({
      documentId: document.id,
      agentId: first.summary.agentId,
      assignmentType: "owner",
      status: "active",
      note: "정본 운영 담당",
    });
    expect(listWorkspaceAgents(database, workspace.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.summary.agentId, activeAssignmentCount: 1 }),
      expect.objectContaining({ id: second.summary.agentId, activeAssignmentCount: 0 }),
    ]));
    expect(database.prepare(
      "SELECT root_document_id FROM workspace_api_tokens WHERE id = ?",
    ).get(first.summary.id)).toEqual({ root_document_id: null });
    expect(database.prepare(
      "SELECT metadata_json FROM workspace_audit_events WHERE action = 'assignment.created' ORDER BY cursor DESC LIMIT 1",
    ).get()).toEqual(expect.objectContaining({
      metadata_json: expect.stringContaining('"grantsAccess":false'),
    }));

    updateAssignment(database, workspace.id, assignment.id, actor, { status: "completed" });
    expect(listAssignments(database, workspace.id, { status: "active" })).toHaveLength(0);
  });

  it("excludes revoked or inactive agent grants from active lists and assignment targets while retaining history", () => {
    const { database, workspace, document, first, second, actor } = fixture();
    const disabled = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: actor.userId,
      name: "Disabled",
      role: "editor",
    });
    const deleted = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: actor.userId,
      name: "Deleted",
      role: "editor",
    });
    const purged = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: actor.userId,
      name: "Purged",
      role: "editor",
    });
    const historicalAssignment = assignDocument(database, workspace.id, actor, {
      documentId: document.id,
      agentId: second.summary.agentId,
      assignmentType: "reviewer",
    });
    const now = new Date().toISOString();
    database.prepare("UPDATE workspace_agents SET revoked_at = ? WHERE id = ?")
      .run(now, second.summary.agentId);
    database.prepare(
      `UPDATE agents SET status = 'disabled'
       WHERE id = (SELECT agent_identity_id FROM workspace_agents WHERE id = ?)`,
    ).run(disabled.summary.agentId);
    database.prepare(
      `UPDATE agents SET deleted_at = ?
       WHERE id = (SELECT agent_identity_id FROM workspace_agents WHERE id = ?)`,
    ).run(now, deleted.summary.agentId);
    database.prepare(
      `UPDATE agents SET purged_at = ?
       WHERE id = (SELECT agent_identity_id FROM workspace_agents WHERE id = ?)`,
    ).run(now, purged.summary.agentId);

    const activeAgentIds = listWorkspaceAgents(database, workspace.id).map((agent) => agent.id);
    expect(activeAgentIds).toContain(first.summary.agentId);
    expect(activeAgentIds).not.toEqual(expect.arrayContaining([
      second.summary.agentId,
      disabled.summary.agentId,
      deleted.summary.agentId,
      purged.summary.agentId,
    ]));
    expect(listAssignmentHistory(database, workspace.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: historicalAssignment.id, agentId: second.summary.agentId }),
    ]));
    for (const agentId of [
      second.summary.agentId,
      disabled.summary.agentId,
      deleted.summary.agentId,
      purged.summary.agentId,
    ]) {
      expect(() => assignDocument(database, workspace.id, actor, {
        documentId: document.id,
        agentId,
        assignmentType: "owner",
      })).toThrowError("활성 에이전트를 찾을 수 없습니다.");
    }
  });

  it("runs dynamic saved views over assignment and recent-update filters", () => {
    const { database, workspace, document, first, actor } = fixture();
    assignDocument(database, workspace.id, actor, {
      documentId: document.id,
      agentId: first.summary.agentId,
      assignmentType: "contributor",
    });
    const view = createSavedView(database, workspace.id, actor, {
      name: "Gameroom 최근 담당 문서",
      visibility: "workspace",
      query: {
        assignedAgentId: first.summary.agentId,
        assignmentType: "contributor",
        updatedWithinDays: 7,
        sort: "updated_desc",
      },
    });

    const result = runSavedView(database, workspace.id, view.id, actor);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      id: document.id,
      assignments: [expect.objectContaining({ agentId: first.summary.agentId })],
    });
    expect(queryDocuments(database, workspace.id, { unassigned: true }).documents)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: document.id })]));
  });

  it("shows private views only to their creator", () => {
    const { database, workspace, actor, first } = fixture();
    createSavedView(database, workspace.id, actor, {
      name: "나만 보는 보기",
      visibility: "private",
      query: { workflowStatus: "draft" },
    });

    expect(listSavedViews(database, workspace.id, actor).map((view) => view.name))
      .toContain("나만 보는 보기");
    expect(listSavedViews(database, workspace.id, {
      type: "agent",
      agentId: first.summary.agentId,
      label: first.summary.name,
    }).map((view) => view.name)).not.toContain("나만 보는 보기");
  });

  it("treats migrated legacy agent IDs as opaque stable identities", () => {
    const { database, user, workspace, document, actor } = fixture();
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, avatar_media_id, status,
        created_by_user_id, created_at, updated_at)
       VALUES ('legacy-agent-gameroom', ?, 'Gameroom Main', NULL, 'active', ?, ?, ?)`,
    ).run(user.id, user.id, now, now);
    database.prepare(
      `INSERT INTO agent_ownership
       (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES ('legacy-agent-gameroom', 'personal', ?, NULL, ?, ?)`,
    ).run(user.id, now, now);
    database.prepare(
      `INSERT INTO workspace_agents
       (id, workspace_id, display_name, avatar_media_id, role, status,
         created_by_user_id, created_at, updated_at, agent_identity_id)
       VALUES ('legacy-agent-gameroom', ?, 'Gameroom Main', NULL, 'editor', 'active', ?, ?, ?,
               'legacy-agent-gameroom')`,
    ).run(workspace.id, user.id, now, now);

    const input = createAssignmentSchema.parse({
      documentId: document.id,
      agentId: "legacy-agent-gameroom",
      assignmentType: "owner",
    });
    expect(savedViewQuerySchema.parse({ assignedAgentId: "legacy-agent-gameroom" }))
      .toEqual({ assignedAgentId: "legacy-agent-gameroom" });
    expect(assignDocument(database, workspace.id, actor, input))
      .toMatchObject({ agentId: "legacy-agent-gameroom" });
  });
});
