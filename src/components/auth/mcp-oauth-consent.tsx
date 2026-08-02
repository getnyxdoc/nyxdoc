"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  Bot,
  Building2,
  Check,
  Plus,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { UserAvatar } from "@/components/profile/user-avatar";
import type { AgentWorkspaceRole } from "@/lib/authz/permissions";
import { useI18n } from "@/lib/i18n/client";
import styles from "./mcp-oauth-consent.module.css";

type ConsentWorkspace = {
  id: string;
  name: string;
  slug: string;
  owner: boolean;
  humanRole: string;
  namespace: {
    type: "personal" | "organization";
    id: string;
    name: string;
  };
};

type ConsentAgent = {
  id: string;
  displayName: string;
  avatarMediaId: string | null;
  owner: {
    type: "personal" | "organization";
    id: string;
    name: string;
  };
  activeWorkspaceCount: number;
  activeCredentialCount: number;
};

const copy = {
  en: {
    app: "Application",
    agent: "Agent identity",
    agentHelp: "Choose which Nyxdoc agent this OAuth connection will act as.",
    newAgent: "New agent",
    newAgentHelp: "Recommended for a new application. Its history and credentials stay separate.",
    existingAgent: "Existing agent",
    existingAgentHelp: "Use one identity across applications while keeping this OAuth credential separate.",
    agentName: "Agent name",
    agentNamePlaceholder: "e.g. Codex work agent",
    noAgents: "There is no existing agent compatible with the selected workspaces.",
    personalOwner: "Personal",
    organizationOwner: "Organization",
    agentCounts: (workspaces: number, credentials: number) =>
      `${workspaces} workspace${workspaces === 1 ? "" : "s"} · ${credentials} active credential${credentials === 1 ? "" : "s"}`,
    existingWarning: "Activity from this application will be recorded under the selected agent. Reauthorizing as another agent revokes the previous OAuth token set.",
    permissions: "Requested access",
    workspaces: "Workspaces",
    workspacesHelp: "Choose where this external agent may work. You can change or revoke access later.",
    role: "Workspace role",
    roleHelp: "Applied when the agent is newly assigned. Existing workspace roles are not changed.",
    roles: {
      admin: ["Administrator", "Manage the workspace and work on documents"],
      editor: ["Editor", "Read, write, and save documents"],
      viewer: ["Viewer", "Read documents only"],
    },
    security: "Nyxdoc keeps each workspace boundary and document scope in force after authorization.",
    deny: "Cancel",
    allow: "Connect",
    connecting: "Connecting…",
    none: "There is no workspace you can authorize.",
    error: "The connection could not be authorized.",
  },
  ko: {
    app: "연결할 앱",
    agent: "에이전트 신원",
    agentHelp: "이 OAuth 연결이 어떤 Nyxdoc 에이전트로 작업할지 선택하세요.",
    newAgent: "새 에이전트",
    newAgentHelp: "새 앱에는 이 방식을 권장합니다. 작업 기록과 연결 자격이 별도로 관리됩니다.",
    existingAgent: "기존 에이전트",
    existingAgentHelp: "여러 앱에서 같은 신원을 사용하되 OAuth 연결 자격은 앱별로 분리합니다.",
    agentName: "에이전트 이름",
    agentNamePlaceholder: "예: Codex 업무 에이전트",
    noAgents: "선택한 워크스페이스에서 사용할 수 있는 기존 에이전트가 없습니다.",
    personalOwner: "개인",
    organizationOwner: "조직",
    agentCounts: (workspaces: number, credentials: number) =>
      `워크스페이스 ${workspaces}곳 · 활성 연결 키 ${credentials}개`,
    existingWarning: "이 앱의 활동은 선택한 에이전트의 기록으로 남습니다. 다른 에이전트로 다시 승인하면 이전 OAuth 토큰은 모두 폐기됩니다.",
    permissions: "요청 권한",
    workspaces: "접근할 워크스페이스",
    workspacesHelp: "외부 에이전트가 작업할 공간을 선택하세요. 권한은 나중에 변경하거나 철회할 수 있습니다.",
    role: "워크스페이스 역할",
    roleHelp: "에이전트를 새로 할당하는 공간에 적용됩니다. 기존 워크스페이스 역할은 바꾸지 않습니다.",
    roles: {
      admin: ["관리자", "워크스페이스 관리와 문서 작업"],
      editor: ["편집자", "문서 읽기·작성·저장"],
      viewer: ["뷰어", "문서 읽기 전용"],
    },
    security: "연결 후에도 Nyxdoc의 워크스페이스 경계와 문서 접근 범위가 그대로 적용됩니다.",
    deny: "취소",
    allow: "연결",
    connecting: "연결 중…",
    none: "연결 권한을 부여할 수 있는 워크스페이스가 없습니다.",
    error: "연결을 승인하지 못했습니다.",
  },
  ja: {
    app: "接続するアプリ",
    agent: "エージェント ID",
    agentHelp: "この OAuth 接続がどの Nyxdoc エージェントとして動作するか選択します。",
    newAgent: "新しいエージェント",
    newAgentHelp: "新しいアプリに推奨します。履歴と接続資格情報が分離されます。",
    existingAgent: "既存のエージェント",
    existingAgentHelp: "複数のアプリで同じ ID を使い、OAuth 資格情報はアプリごとに分離します。",
    agentName: "エージェント名",
    agentNamePlaceholder: "例: Codex 業務エージェント",
    noAgents: "選択したワークスペースで使用できる既存のエージェントがありません。",
    personalOwner: "個人",
    organizationOwner: "組織",
    agentCounts: (workspaces: number, credentials: number) =>
      `ワークスペース ${workspaces}件・有効な接続キー ${credentials}件`,
    existingWarning: "このアプリの操作は選択したエージェントの履歴として記録されます。別のエージェントで再承認すると、以前の OAuth トークンはすべて失効します。",
    permissions: "要求された権限",
    workspaces: "アクセスするワークスペース",
    workspacesHelp: "外部エージェントが作業できる場所を選択します。権限は後から変更・取り消しできます。",
    role: "ワークスペースの役割",
    roleHelp: "エージェントを新しく割り当てる場合に適用され、既存の役割は変更されません。",
    roles: {
      admin: ["管理者", "ワークスペース管理と文書作業"],
      editor: ["編集者", "文書の閲覧・編集・保存"],
      viewer: ["閲覧者", "文書の閲覧のみ"],
    },
    security: "接続後も Nyxdoc のワークスペース境界と文書アクセス範囲が適用されます。",
    deny: "キャンセル",
    allow: "接続",
    connecting: "接続中…",
    none: "接続を許可できるワークスペースがありません。",
    error: "接続を承認できませんでした。",
  },
} as const;

export function McpOAuthConsent({
  client,
  consentCode,
  requestedScopes,
  workspaces,
  initialWorkspaceIds,
  initialRole,
  agents,
  initialAgent,
}: {
  client: { clientId: string; name: string; icon: string | null };
  consentCode: string;
  requestedScopes: string[];
  workspaces: ConsentWorkspace[];
  initialWorkspaceIds: string[];
  initialRole: AgentWorkspaceRole;
  agents: ConsentAgent[];
  initialAgent:
    | { mode: "new"; displayName: string }
    | { mode: "existing"; agentId: string };
}) {
  const { locale } = useI18n();
  const text = copy[locale];
  const allowedWorkspaceIds = useMemo(
    () => new Set(workspaces.map((workspace) => workspace.id)),
    [workspaces],
  );
  const initialSelection = initialWorkspaceIds.filter((id) => allowedWorkspaceIds.has(id));
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(
    initialSelection.length ? initialSelection : workspaces[0] ? [workspaces[0].id] : [],
  );
  const [role, setRole] = useState<AgentWorkspaceRole>(initialRole);
  const [agentMode, setAgentMode] = useState<"new" | "existing">(initialAgent.mode);
  const [newAgentName, setNewAgentName] = useState(
    initialAgent.mode === "new"
      ? initialAgent.displayName
      : `${client.name.trim().replace(/\s+/g, " ").slice(0, 74)} OAuth`,
  );
  const [selectedAgentId, setSelectedAgentId] = useState(
    initialAgent.mode === "existing" ? initialAgent.agentId : agents[0]?.id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const compatibleAgents = useMemo(() => {
    const selectedWorkspaces = workspaces.filter(
      (workspace) => workspaceIds.includes(workspace.id),
    );
    return agents.filter((agent) => selectedWorkspaces.every((workspace) => {
      if (agent.owner.type === "organization") {
        return workspace.namespace.type === "organization"
          && workspace.namespace.id === agent.owner.id;
      }
      return workspace.namespace.type === "organization"
        || workspace.namespace.id === agent.owner.id;
    }));
  }, [agents, workspaceIds, workspaces]);
  const effectiveSelectedAgentId = compatibleAgents.some(
    (agent) => agent.id === selectedAgentId,
  ) ? selectedAgentId : compatibleAgents[0]?.id ?? "";

  function toggleWorkspace(workspaceId: string) {
    setWorkspaceIds((current) => current.includes(workspaceId)
      ? current.filter((id) => id !== workspaceId)
      : [...current, workspaceId]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await decide(true);
  }

  async function decide(accept: boolean) {
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/mcp/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accept,
          consentCode,
          workspaceIds,
          role,
          ...(accept ? {
            agent: agentMode === "existing"
              ? { mode: "existing", agentId: effectiveSelectedAgentId }
              : { mode: "new", displayName: newAgentName.trim() },
          } : {}),
        }),
      });
      const result = await response.json() as {
        redirectURI?: string;
        error?: string;
      };
      if (!response.ok || !result.redirectURI) {
        throw new Error(result.error || text.error);
      }
      window.location.assign(result.redirectURI);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : text.error);
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <section className={styles.clientCard}>
        <span className={styles.clientIcon}>
          <Bot aria-hidden size={25} />
        </span>
        <span>
          <small>{text.app}</small>
          <strong>{client.name}</strong>
        </span>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <UsersRound aria-hidden size={18} />
          <span>
            <strong>{text.agent}</strong>
            <small>{text.agentHelp}</small>
          </span>
        </div>
        <div className={styles.agentModes} role="group" aria-label={text.agent}>
          <button
            type="button"
            className={agentMode === "new" ? styles.agentModeSelected : ""}
            aria-pressed={agentMode === "new"}
            onClick={() => setAgentMode("new")}
          >
            <Plus size={16} aria-hidden />
            <span><strong>{text.newAgent}</strong><small>{text.newAgentHelp}</small></span>
          </button>
          <button
            type="button"
            className={agentMode === "existing" ? styles.agentModeSelected : ""}
            aria-pressed={agentMode === "existing"}
            onClick={() => {
              if (!compatibleAgents.length) return;
              setSelectedAgentId(effectiveSelectedAgentId);
              setAgentMode("existing");
            }}
            disabled={!compatibleAgents.length}
          >
            <Bot size={16} aria-hidden />
            <span><strong>{text.existingAgent}</strong><small>{text.existingAgentHelp}</small></span>
          </button>
        </div>
        {agentMode === "new" ? (
          <label className={styles.agentName}>
            <span>{text.agentName}</span>
            <input
              type="text"
              value={newAgentName}
              maxLength={80}
              placeholder={text.agentNamePlaceholder}
              onChange={(event) => setNewAgentName(event.target.value)}
            />
          </label>
        ) : compatibleAgents.length ? (
          <>
            <div className={styles.agentList}>
              {compatibleAgents.map((agent) => {
                const selected = effectiveSelectedAgentId === agent.id;
                return (
                  <label
                    className={`${styles.agentChoice} ${selected ? styles.agentChoiceSelected : ""}`}
                    key={agent.id}
                  >
                    <input
                      type="radio"
                      name="mcp-oauth-agent"
                      value={agent.id}
                      checked={selected}
                      onChange={() => setSelectedAgentId(agent.id)}
                    />
                    <UserAvatar
                      className={styles.agentAvatar}
                      imageUrl={agent.avatarMediaId ? `/api/media/${agent.avatarMediaId}` : null}
                      name={agent.displayName}
                    />
                    <span className={styles.agentDetails}>
                      <strong>{agent.displayName}</strong>
                      <small>
                        {agent.owner.type === "organization"
                          ? text.organizationOwner
                          : text.personalOwner} · {agent.owner.name}
                      </small>
                      <small>{text.agentCounts(
                        agent.activeWorkspaceCount,
                        agent.activeCredentialCount,
                      )}</small>
                    </span>
                    <span className={styles.agentCheck}>{selected && <Check size={14} />}</span>
                  </label>
                );
              })}
            </div>
            <p className={styles.agentWarning}>{text.existingWarning}</p>
          </>
        ) : <p className={styles.empty}>{text.noAgents}</p>}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <Building2 aria-hidden size={18} />
          <span>
            <strong>{text.workspaces}</strong>
            <small>{text.workspacesHelp}</small>
          </span>
        </div>
        {workspaces.length ? (
          <div className={styles.workspaceList}>
            {workspaces.map((workspace) => {
              const selected = workspaceIds.includes(workspace.id);
              return (
                <label
                  className={`${styles.workspace} ${selected ? styles.workspaceSelected : ""}`}
                  key={workspace.id}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleWorkspace(workspace.id)}
                  />
                  <span className={styles.check}>{selected && <Check size={14} />}</span>
                  <span>
                    <strong>{workspace.name}</strong>
                    <small>{workspace.owner ? "Owner" : workspace.humanRole}</small>
                  </span>
                </label>
              );
            })}
          </div>
        ) : <p className={styles.empty}>{text.none}</p>}
      </section>

      <section className={styles.section}>
        <label className={styles.roleLabel} htmlFor="mcp-role">
          <strong>{text.role}</strong>
          <small>{text.roleHelp}</small>
        </label>
        <select
          id="mcp-role"
          value={role}
          onChange={(event) => setRole(event.target.value as AgentWorkspaceRole)}
        >
          {(["admin", "editor", "viewer"] as const).map((value) => (
            <option value={value} key={value}>
              {text.roles[value][0]} · {text.roles[value][1]}
            </option>
          ))}
        </select>
      </section>

      <details className={styles.scopes}>
        <summary>{text.permissions} · {requestedScopes.length}</summary>
        <div>{requestedScopes.map((scope) => <code key={scope}>{scope}</code>)}</div>
      </details>

      <p className={styles.security}><ShieldCheck aria-hidden size={17} />{text.security}</p>
      {error && <div className={styles.error} role="alert">{error}</div>}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.deny}
          onClick={() => void decide(false)}
          disabled={pending}
        ><X size={16} />{text.deny}</button>
        <button
          type="submit"
          className={styles.allow}
          disabled={
            pending
            || !workspaceIds.length
            || (agentMode === "new" ? !newAgentName.trim() : !effectiveSelectedAgentId)
          }
        >{pending ? text.connecting : text.allow}<Check size={17} /></button>
      </div>
    </form>
  );
}
