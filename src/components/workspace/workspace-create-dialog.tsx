"use client";

import { type FormEvent, useState } from "react";
import { ArrowRight, Building2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { rememberWorkspaceSelection } from "@/lib/workspaces/selection";
import type { OrganizationSummary } from "@/lib/organizations/service";
import styles from "./workspace-create-dialog.module.css";

export const CREATE_WORKSPACE_OPTION_VALUE = "__create_workspace__";

type CreateWorkspaceResponse = {
  error?: string;
  workspace?: {
    id: string;
    name: string;
  };
};

export function WorkspaceCreateDialog({
  fixedOrganization,
  initialOrganizationId = null,
  onClose,
  organizations = [],
}: {
  fixedOrganization?: OrganizationSummary;
  initialOrganizationId?: string | null;
  onClose: () => void;
  organizations?: OrganizationSummary[];
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      failed: "Could not create the workspace.",
      title: "Create a workspace",
      close: "Close workspace creation",
      workspace: "Workspace",
      agent: "Connect an agent",
      question: "What workspace would you like to create?",
      description: "Documents, people, agents, permissions, and audit records are isolated from other workspaces.",
      name: "Workspace name",
      owner: "Owner namespace",
      personal: "Personal · only you own this workspace",
      organizationOwned: "Organization · members still need explicit access",
      placeholder: "Example: Product development",
      nextHint: "On the next screen, connect one agent or choose to do it later.",
      cancel: "Cancel",
      creating: "Creating…",
      next: "Next: connect an agent",
    },
    ko: {
      failed: "워크스페이스를 만들지 못했습니다.",
      title: "새 워크스페이스 만들기",
      close: "새 워크스페이스 만들기 닫기",
      workspace: "워크스페이스",
      agent: "에이전트 연결",
      question: "어떤 작업 공간을 만들까요?",
      description: "문서·사람·에이전트·권한과 감사 기록이 다른 워크스페이스와 분리됩니다.",
      name: "워크스페이스 이름",
      owner: "소유 네임스페이스",
      personal: "개인 · 내가 소유하는 워크스페이스",
      organizationOwned: "조직 · 조직 멤버도 별도 접근 권한 필요",
      placeholder: "예: 제품 개발",
      nextHint: "다음 화면에서 에이전트 한 명을 연결하거나 나중에 연결할 수 있습니다.",
      cancel: "취소",
      creating: "만드는 중…",
      next: "다음: 에이전트 연결",
    },
    ja: {
      failed: "ワークスペースを作成できませんでした。",
      title: "新しいワークスペースを作成",
      close: "ワークスペース作成を閉じる",
      workspace: "ワークスペース",
      agent: "エージェント接続",
      question: "どのような作業スペースを作りますか？",
      description: "文書、人、エージェント、権限、監査記録は他のワークスペースから分離されます。",
      name: "ワークスペース名",
      owner: "所有名前空間",
      personal: "個人・自分が所有するワークスペース",
      organizationOwned: "組織・メンバーにも明示的なアクセスが必要",
      placeholder: "例：製品開発",
      nextHint: "次の画面でエージェントを1つ接続するか、後で接続できます。",
      cancel: "キャンセル",
      creating: "作成中…",
      next: "次へ：エージェント接続",
    },
  }[locale];
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState(
    fixedOrganization?.id ?? initialOrganizationId ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const normalizedName = name.trim().replace(/\s+/g, " ");

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedName || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: normalizedName,
          organizationId: organizationId || undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as CreateWorkspaceResponse;
      if (!response.ok || !body.workspace) {
        throw new Error(body.error || copy.failed);
      }
      rememberWorkspaceSelection(body.workspace.id);
      window.location.assign(
        `/settings/workspace?workspace=${encodeURIComponent(body.workspace.id)}`
        + "&connectAgent=1&workspaceOnboarding=1#workspace-agents",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
      setPending(false);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-workspace-title"
        onSubmit={createWorkspace}
      >
        <header>
          <span><Building2 size={21} /></span>
          <div>
            <p>NEW WORKSPACE</p>
            <h2 id="create-workspace-title">{copy.title}</h2>
          </div>
          <button
            type="button"
            aria-label={copy.close}
            disabled={pending}
            onClick={onClose}
          ><X size={19} /></button>
        </header>

        <div className={styles.body}>
          <div className={styles.progress}>
            <strong><span>1</span> {copy.workspace}</strong>
            <i />
            <span><b>2</b> {copy.agent}</span>
          </div>
          <div>
            <h3>{copy.question}</h3>
            <p>{copy.description}</p>
          </div>
          <label>
            <span>{copy.name}</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={copy.placeholder}
              maxLength={120}
              disabled={pending}
            />
          </label>
          {fixedOrganization ? (
            <div className={styles.ownerNotice}>
              <span>{fixedOrganization.icon || <Building2 size={17} />}</span>
              <div><strong>{fixedOrganization.name}</strong><small>{copy.organizationOwned}</small></div>
            </div>
          ) : organizations.length > 0 && (
            <label>
              <span>{copy.owner}</span>
              <select
                value={organizationId}
                disabled={pending}
                onChange={(event) => setOrganizationId(event.target.value)}
              >
                <option value="">{copy.personal}</option>
                {organizations.map((organization) => (
                  <option value={organization.id} key={organization.id}>
                    {organization.icon ? `${organization.icon} ` : ""}{organization.name} · {copy.organizationOwned}
                  </option>
                ))}
              </select>
            </label>
          )}
          <small>{copy.nextHint}</small>
          {error && <div className={styles.error} role="alert">{error}</div>}
        </div>

        <footer>
          <button type="button" disabled={pending} onClick={onClose}>{copy.cancel}</button>
          <button type="submit" disabled={pending || !normalizedName}>
            {pending ? copy.creating : copy.next} <ArrowRight size={15} />
          </button>
        </footer>
      </form>
    </div>
  );
}
