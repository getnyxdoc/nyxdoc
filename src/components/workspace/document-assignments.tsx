"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, UserPlus, Users, X } from "lucide-react";
import { UserAvatar } from "@/components/profile/user-avatar";
import { useI18n } from "@/lib/i18n/client";
import type {
  AssignmentType,
  DocumentAssignment,
  WorkspaceAgentSummary,
} from "@/lib/collaboration/types";
import styles from "./workspace.module.css";

async function readResponse(response: Response) {
  return await response.json().catch(() => ({})) as {
    error?: string;
    assignment?: DocumentAssignment;
  };
}

export function DocumentAssignments({
  workspaceId,
  documentId,
  agents,
  assignments,
  canManage,
}: {
  workspaceId: string;
  documentId: string;
  agents: WorkspaceAgentSummary[];
  assignments: DocumentAssignment[];
  canManage: boolean;
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      owner: "Primary",
      contributor: "Collaborator",
      reviewer: "Reviewer",
      assignFailed: "Could not assign the agent.",
      statusFailed: "Could not change the assignment status.",
      titleHint: "Agents responsible for this document",
      assignedCount: "{count} assigned",
      assigned: "Assigned",
      title: "Assigned agents",
      description: "Assignments communicate responsibility. They do not change access permissions or key scope.",
      close: "Close",
      empty: "No agent is responsible for this document yet.",
      complete: "Complete assignment",
      cancelAssignment: "Cancel assignment",
      agent: "Agent",
      role: "Role",
      note: "Note",
      optional: "Optional",
      placeholder: "Example: Review the balance document",
      assigning: "Assigning…",
      assign: "Assign",
      settingsLead: "Assign an agent first in",
      workspaceSettings: "workspace settings",
      settingsTail: ".",
    },
    ko: {
      owner: "주 담당",
      contributor: "공동 작업",
      reviewer: "검토",
      assignFailed: "담당 에이전트를 지정하지 못했습니다.",
      statusFailed: "담당 상태를 바꾸지 못했습니다.",
      titleHint: "이 문서의 담당 에이전트",
      assignedCount: "담당 {count}",
      assigned: "담당",
      title: "담당 에이전트",
      description: "담당 지정은 책임을 표시하며 접근 권한이나 키 범위를 바꾸지 않습니다.",
      close: "닫기",
      empty: "아직 이 문서를 담당하는 에이전트가 없습니다.",
      complete: "담당 완료",
      cancelAssignment: "담당 취소",
      agent: "에이전트",
      role: "역할",
      note: "메모",
      optional: "선택",
      placeholder: "예: 밸런스 문서 검토",
      assigning: "지정 중…",
      assign: "담당 지정",
      settingsLead: "먼저",
      workspaceSettings: "워크스페이스 설정",
      settingsTail: "에서 에이전트를 배정해주세요.",
    },
    ja: {
      owner: "主担当",
      contributor: "共同作業",
      reviewer: "レビュー",
      assignFailed: "担当エージェントを指定できませんでした。",
      statusFailed: "担当状態を変更できませんでした。",
      titleHint: "この文書の担当エージェント",
      assignedCount: "担当 {count}",
      assigned: "担当",
      title: "担当エージェント",
      description: "担当指定は責任範囲を示すもので、アクセス権限やキー範囲は変更しません。",
      close: "閉じる",
      empty: "この文書を担当するエージェントはまだいません。",
      complete: "担当を完了",
      cancelAssignment: "担当をキャンセル",
      agent: "エージェント",
      role: "役割",
      note: "メモ",
      optional: "任意",
      placeholder: "例：バランス文書をレビュー",
      assigning: "割り当て中…",
      assign: "担当を指定",
      settingsLead: "先に",
      workspaceSettings: "ワークスペース設定",
      settingsTail: "でエージェントを割り当ててください。",
    },
  }[locale];
  const assignmentLabel: Record<AssignmentType, string> = {
    owner: copy.owner,
    contributor: copy.contributor,
    reviewer: copy.reviewer,
  };
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [assignmentType, setAssignmentType] = useState<AssignmentType>("contributor");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const activeAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.documentId === documentId && assignment.status === "active"),
    [assignments, documentId],
  );

  function workspaceRequest(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("x-nyxdoc-workspace-id", workspaceId);
    return fetch(input, { ...init, headers });
  }

  async function createAssignment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentId || pending) return;
    setPending("create");
    setError("");
    const response = await workspaceRequest("/api/assignments", {
      method: "POST",
      body: JSON.stringify({ documentId, agentId, assignmentType, note: note.trim() || null }),
    });
    const body = await readResponse(response);
    setPending(null);
    if (!response.ok) {
      setError(body.error || copy.assignFailed);
      return;
    }
    setNote("");
    router.refresh();
  }

  async function changeAssignment(assignmentId: string, status: "completed" | "cancelled") {
    if (pending) return;
    setPending(assignmentId);
    setError("");
    const response = await workspaceRequest(`/api/assignments/${assignmentId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    const body = await readResponse(response);
    setPending(null);
    if (!response.ok) {
      setError(body.error || copy.statusFailed);
      return;
    }
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className={styles.collaboratorButton}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
        title={copy.titleHint}
      >
        {activeAssignments.length > 0 ? (
          <span className={styles.collaboratorAvatars}>
            {activeAssignments.slice(0, 3).map((assignment) => (
              <UserAvatar
                key={assignment.id}
                className={styles.collaboratorAvatar}
                imageUrl={assignment.agentAvatarMediaId ? `/api/media/${assignment.agentAvatarMediaId}` : null}
                name={assignment.agentDisplayName}
              />
            ))}
          </span>
        ) : <Users size={15} />}
        <span>{activeAssignments.length > 0 ? copy.assignedCount.replace("{count}", String(activeAssignments.length)) : copy.assigned}</span>
      </button>

      {open && createPortal((
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !pending) setOpen(false);
        }}>
          <section className={styles.assignmentDialog} role="dialog" aria-modal="true" aria-labelledby="assignment-title">
            <header>
              <div>
                <span><Users size={18} /></span>
                <div>
                  <h2 id="assignment-title">{copy.title}</h2>
                  <p>{copy.description}</p>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} disabled={Boolean(pending)} aria-label={copy.close}><X size={18} /></button>
            </header>

            <div className={styles.assignmentList}>
              {activeAssignments.length === 0 ? (
                <p className={styles.emptyAssignments}>{copy.empty}</p>
              ) : activeAssignments.map((assignment) => (
                <article key={assignment.id}>
                  <UserAvatar
                    className={styles.assignmentAvatar}
                    imageUrl={assignment.agentAvatarMediaId ? `/api/media/${assignment.agentAvatarMediaId}` : null}
                    name={assignment.agentDisplayName}
                  />
                  <div>
                    <strong>{assignment.agentDisplayName}</strong>
                    <small>{assignmentLabel[assignment.assignmentType]}{assignment.note ? ` · ${assignment.note}` : ""}</small>
                  </div>
                  {canManage && (
                    <div className={styles.assignmentRowActions}>
                      <button type="button" onClick={() => changeAssignment(assignment.id, "completed")} disabled={Boolean(pending)} title={copy.complete}><Check size={14} /></button>
                      <button type="button" onClick={() => changeAssignment(assignment.id, "cancelled")} disabled={Boolean(pending)} title={copy.cancelAssignment}><X size={14} /></button>
                    </div>
                  )}
                </article>
              ))}
            </div>

            {canManage && agents.length > 0 && (
              <form className={styles.assignmentForm} onSubmit={createAssignment}>
                <div>
                  <label>{copy.agent}
                    <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
                      {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}
                    </select>
                  </label>
                  <label>{copy.role}
                    <select value={assignmentType} onChange={(event) => setAssignmentType(event.target.value as AssignmentType)}>
                      <option value="owner">{copy.owner}</option>
                      <option value="contributor">{copy.contributor}</option>
                      <option value="reviewer">{copy.reviewer}</option>
                    </select>
                  </label>
                </div>
                <label>{copy.note} <span>{copy.optional}</span>
                  <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder={copy.placeholder} />
                </label>
                <button type="submit" disabled={!agentId || Boolean(pending)}><UserPlus size={15} /> {pending === "create" ? copy.assigning : copy.assign}</button>
              </form>
            )}

            {canManage && agents.length === 0 && (
              <p className={styles.noAgentsNotice}>{copy.settingsLead} <Link href={`/settings/workspace?workspace=${encodeURIComponent(workspaceId)}#workspace-agents`}>{copy.workspaceSettings}</Link>{copy.settingsTail}</p>
            )}
            {error && <div className={styles.assignmentError} role="alert">{error}</div>}
            <footer><button type="button" onClick={() => setOpen(false)} disabled={Boolean(pending)}>{copy.close}</button></footer>
          </section>
        </div>
      ), document.body)}
    </>
  );
}
