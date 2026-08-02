import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentWorkspacePrincipal } from "@/lib/authz/permissions";
import {
  listAdminActionRequests,
  proposeAdminAction,
  reviewAdminAction,
} from "@/lib/admin-requests/service";
import type { NyxDatabase } from "@/lib/db/client";
import { createWorkspaceToken, updateWorkspaceAgent } from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture(role: AgentWorkspacePrincipal["role"] = "admin") {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const connection = createWorkspaceToken(database, {
    workspaceId: workspace.id,
    userId: user.id,
    name: "Nyx 관리자",
    role,
    scopes: role === "viewer"
      ? ["documents:read", "changes:read"]
      : ["documents:read", "documents:write", "changes:read"],
  });
  const principal: AgentWorkspacePrincipal = {
    type: "agent",
    workspaceId: workspace.id,
    agentId: connection.summary.agentId,
    membershipId: connection.summary.agentId,
    role,
    permissionAllow: [],
    permissionDeny: [],
    displayName: connection.summary.name,
    avatarMediaId: null,
  };
  return { database, user, workspace, connection, principal };
}

describe("human-approved admin action requests", () => {
  it("queues idempotently and changes no workspace setting before human approval", () => {
    const { database, user, workspace, principal } = fixture();
    const input = {
      requestId: randomUUID(),
      reason: "운영 정책을 45일 보존으로 맞추기 위해",
      action: {
        actionType: "workspace.update" as const,
        payload: { name: "Gameroom", trashRetentionDays: 45 },
      },
    };

    const first = proposeAdminAction(database, principal, input);
    const retried = proposeAdminAction(database, principal, input);
    expect(retried.id).toBe(first.id);
    expect(first).toMatchObject({ status: "pending", requestedByAgentId: principal.agentId });
    expect(database.prepare(
      "SELECT name, trash_retention_days FROM workspaces WHERE id = ?",
    ).get(workspace.id)).toEqual({ name: workspace.name, trash_retention_days: 30 });

    const result = reviewAdminAction(database, workspace.id, user, first.id, {
      decision: "approve",
      note: "운영 보존 정책 확인",
    });
    expect(result.request.status).toBe("executed");
    expect(database.prepare(
      "SELECT name, trash_retention_days FROM workspaces WHERE id = ?",
    ).get(workspace.id)).toEqual({ name: "Gameroom", trash_retention_days: 45 });
    expect(database.prepare(
      "SELECT action FROM workspace_audit_events WHERE workspace_id = ? ORDER BY cursor DESC LIMIT 1",
    ).get(workspace.id)).toEqual({ action: "admin_request.executed" });
  });

  it("keeps management proposals unavailable to ordinary agents", () => {
    const { database, principal } = fixture("editor");
    expect(() => proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "이 요청은 거부되어야 함",
      action: { actionType: "workspace.create", payload: { name: "Denied" } },
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("fails closed when the target changed after the proposal", () => {
    const { database, user, workspace, connection, principal } = fixture();
    const request = proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "에이전트 역할 조정",
      action: {
        actionType: "agent.update",
        payload: { agentId: connection.summary.agentId, role: "viewer" },
      },
    });
    updateWorkspaceAgent(database, {
      workspaceId: workspace.id,
      userId: user.id,
      agentId: connection.summary.agentId,
      displayName: "먼저 바뀐 이름",
    });

    expect(() => reviewAdminAction(database, workspace.id, user, request.id, {
      decision: "approve",
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(listAdminActionRequests(database, workspace.id).find((item) => item.id === request.id))
      .toMatchObject({ status: "failed" });
    expect(database.prepare(
      "SELECT role FROM workspace_agents WHERE id = ?",
    ).get(connection.summary.agentId)).toEqual({ role: "admin" });
  });

  it("reveals an approved connection secret once without persisting it in the request", () => {
    const { database, user, workspace, principal } = fixture();
    const request = proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "새 검토 에이전트 연결",
      action: {
        actionType: "agent.connect",
        payload: {
          name: "Review Agent",
          role: "viewer",
          scopes: ["documents:read", "changes:read"],
          rootDocumentId: null,
        },
      },
    });
    const reviewed = reviewAdminAction(database, workspace.id, user, request.id, {
      decision: "approve",
    });
    expect(reviewed.revealedToken).toMatch(/^nyx_live_/);
    expect(reviewed.tokenSummary?.name).toBe("Review Agent");
    const stored = JSON.stringify(
      listAdminActionRequests(database, workspace.id).find((item) => item.id === request.id),
    );
    expect(stored).not.toContain(reviewed.revealedToken!);
  });
});
