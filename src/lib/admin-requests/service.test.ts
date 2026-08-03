import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  listAgentProfilePermissions,
  type AgentAccessProfile,
  type AgentWorkspacePrincipal,
} from "@/lib/authz/permissions";
import {
  listAdminActionRequests,
  proposeAdminAction,
  reviewAdminAction,
} from "@/lib/admin-requests/service";
import {
  assignAgentToWorkspace,
  createAccountAgent,
  createAgentCredential,
  updateAgentWorkspaceMembership,
} from "@/lib/agents/service";
import type { NyxDatabase } from "@/lib/db/client";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture(accessProfile: AgentAccessProfile = "custom") {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const agent = createAccountAgent(database, { userId: user.id, displayName: "Nyx 관리자" });
  const capabilities = accessProfile === "custom"
    ? ["admin_requests.create" as const]
    : listAgentProfilePermissions(accessProfile);
  const membership = assignAgentToWorkspace(database, {
    workspaceId: workspace.id,
    userId: user.id,
    agentId: agent.id,
    accessProfile,
    ...(accessProfile === "custom" ? { capabilities } : {}),
    rootDocumentId: null,
  });
  const credential = createAgentCredential(database, {
    userId: user.id,
    agentId: agent.id,
    name: "Nyx 관리자 연결 키",
    scopes: ["documents:read", "documents:write", "changes:read"],
    defaultWorkspaceId: workspace.id,
    workspaceAllowlist: [workspace.id],
  });
  const principal: AgentWorkspacePrincipal = {
    type: "agent",
    workspaceId: workspace.id,
    agentId: agent.id,
    membershipId: membership.membershipId,
    accessProfile,
    capabilities,
    displayName: agent.displayName,
    avatarMediaId: null,
  };
  return { database, user, workspace, agent, membership, credential, principal };
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
    expect(first).toMatchObject({ status: "pending", requestedByAgentId: principal.membershipId });
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
    const { database, principal } = fixture("writer");
    expect(() => proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "이 요청은 거부되어야 함",
      action: { actionType: "workspace.create", payload: { name: "Denied" } },
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("fails closed when a canonical workspace grant changed after the proposal", () => {
    const { database, user, workspace, agent, principal } = fixture();
    const request = proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "에이전트 접근 프로필 조정",
      action: {
        actionType: "agent.update",
        payload: { agentId: agent.id, accessProfile: "reader" },
      },
    });
    updateAgentWorkspaceMembership(database, {
      workspaceId: workspace.id,
      userId: user.id,
      agentId: agent.id,
      accessProfile: "custom",
      capabilities: ["admin_requests.create"],
      rootDocumentId: null,
    });

    expect(() => reviewAdminAction(database, workspace.id, user, request.id, {
      decision: "approve",
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(listAdminActionRequests(database, workspace.id).find((item) => item.id === request.id))
      .toMatchObject({ status: "failed" });
    expect(database.prepare(
      "SELECT access_profile FROM workspace_agents WHERE workspace_id = ? AND agent_identity_id = ?",
    ).get(workspace.id, agent.id)).toEqual({ access_profile: "custom" });
  });

  it("creates identity, grant, and explicit credential binding only after approval", () => {
    const { database, user, workspace, principal } = fixture();
    const beforeAgents = database.prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number };
    const beforeCredentials = database.prepare("SELECT COUNT(*) AS count FROM agent_credentials").get() as { count: number };
    const request = proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "새 검토 에이전트 연결",
      action: {
        actionType: "agent.connect",
        payload: {
          name: "Review Agent",
          credentialName: "Review Agent 연결 키",
          accessProfile: "reader",
          scopes: ["documents:read", "changes:read"],
          rootDocumentId: null,
        },
      },
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM agents").get()).toEqual(beforeAgents);
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_credentials").get()).toEqual(beforeCredentials);

    const reviewed = reviewAdminAction(database, workspace.id, user, request.id, {
      decision: "approve",
    });
    expect(reviewed.revealedToken).toMatch(/^nyx_live_/);
    expect(reviewed.tokenSummary?.name).toBe("Review Agent");
    const execution = reviewed.request.executionResult as { agentId: string; membershipId: string; tokenSummary: { id: string } };
    expect(database.prepare(
      `SELECT binding.id
       FROM agent_credential_grant_bindings binding
       WHERE binding.credential_id = ? AND binding.grant_id = ?
         AND binding.status = 'active' AND binding.revoked_at IS NULL`,
    ).get(execution.tokenSummary.id, execution.membershipId)).toEqual({ id: expect.any(String) });
    const stored = JSON.stringify(
      listAdminActionRequests(database, workspace.id).find((item) => item.id === request.id),
    );
    expect(stored).not.toContain(reviewed.revealedToken!);
  });

  it("rejects legacy role payloads and missing custom capabilities before a request is stored", () => {
    const { database, principal } = fixture();
    expect(() => proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "구형 역할 입력 차단",
      action: {
        actionType: "agent.connect",
        payload: {
          name: "Legacy Agent",
          role: "viewer",
          scopes: ["documents:read"],
        },
      },
    } as never)).toThrow();
    expect(() => proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "명시 권한 없는 사용자 지정 접근 차단",
      action: {
        actionType: "agent.connect",
        payload: {
          name: "Incomplete Agent",
          accessProfile: "custom",
          scopes: ["documents:read"],
        },
      },
    } as never)).toThrow();
    expect(listAdminActionRequests(database, principal.workspaceId)).toHaveLength(0);
  });

  it("rejects rotation and revocation of an unbound credential even when it belongs to the workspace agent", () => {
    const { database, user, agent, principal } = fixture();
    const unbound = createAgentCredential(database, {
      userId: user.id,
      agentId: agent.id,
      name: "Other workspace key",
      scopes: ["documents:read", "changes:read"],
      workspaceAllowlist: [],
    });

    expect(() => proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "연결되지 않은 키 회전 차단 확인",
      action: {
        actionType: "credential.rotate",
        payload: { credentialId: unbound.credential.id },
      },
    })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));

    expect(() => proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "연결되지 않은 키 폐기 차단 확인",
      action: {
        actionType: "credential.revoke",
        payload: { credentialId: unbound.credential.id },
      },
    })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));

    expect(database.prepare(
      "SELECT revoked_at FROM agent_credentials WHERE id = ?",
    ).get(unbound.credential.id)).toEqual({ revoked_at: null });
  });

  it("rotates the explicitly selected bound credential and preserves its binding", () => {
    const { database, user, workspace, membership, credential, principal } = fixture();
    const request = proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "현재 워크스페이스에 연결된 키를 교체",
      action: {
        actionType: "credential.rotate",
        payload: { credentialId: credential.credential.id },
      },
    });

    const reviewed = reviewAdminAction(database, workspace.id, user, request.id, { decision: "approve" });
    expect(reviewed.revealedToken).toMatch(/^nyx_live_/);
    expect(reviewed.tokenSummary?.id).not.toBe(credential.credential.id);
    expect(database.prepare(
      "SELECT revoked_at FROM agent_credentials WHERE id = ?",
    ).get(credential.credential.id)).toMatchObject({ revoked_at: expect.any(String) });
    expect(database.prepare(
      `SELECT binding.id
       FROM agent_credential_grant_bindings binding
       WHERE binding.credential_id = ? AND binding.grant_id = ?
         AND binding.status = 'active' AND binding.revoked_at IS NULL`,
    ).get(reviewed.tokenSummary!.id, membership.membershipId)).toEqual({
      id: expect.any(String),
    });
  });

  it("revokes only the explicitly selected bound credential", () => {
    const { database, user, workspace, credential, principal } = fixture();
    const request = proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "현재 워크스페이스에 연결된 키를 폐기",
      action: {
        actionType: "credential.revoke",
        payload: { credentialId: credential.credential.id },
      },
    });

    const reviewed = reviewAdminAction(database, workspace.id, user, request.id, { decision: "approve" });
    expect(reviewed.request.status).toBe("executed");
    expect(database.prepare(
      "SELECT revoked_at FROM agent_credentials WHERE id = ?",
    ).get(credential.credential.id)).toMatchObject({ revoked_at: expect.any(String) });
  });

  it("fails closed if the selected credential binding is removed before approval", () => {
    const { database, user, workspace, membership, credential, principal } = fixture();
    const request = proposeAdminAction(database, principal, {
      requestId: randomUUID(),
      reason: "승인 전에 연결이 해제된 키를 폐기하지 않기 위해",
      action: {
        actionType: "credential.revoke",
        payload: { credentialId: credential.credential.id },
      },
    });
    database.prepare(
      `UPDATE agent_credential_grant_bindings
       SET status = 'revoked', revoked_at = ?
       WHERE credential_id = ? AND grant_id = ?`,
    ).run(new Date().toISOString(), credential.credential.id, membership.membershipId);

    expect(() => reviewAdminAction(database, workspace.id, user, request.id, {
      decision: "approve",
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(database.prepare(
      "SELECT revoked_at FROM agent_credentials WHERE id = ?",
    ).get(credential.credential.id)).toEqual({ revoked_at: null });
  });
});
