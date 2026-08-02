"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FileText, Filter, Plus, Search, Trash2, X } from "lucide-react";
import { UserAvatar } from "@/components/profile/user-avatar";
import { useI18n } from "@/lib/i18n/client";
import { formatCopy } from "@/lib/i18n/copy";
import type {
  AssignmentType,
  SavedView,
  SavedViewQuery,
  SavedViewResult,
  WorkspaceAgentSummary,
} from "@/lib/collaboration/types";
import type { DocumentSummary, DocumentWorkflowStatus } from "@/lib/documents/types";
import styles from "./workspace.module.css";

async function readBody<T>(response: Response) {
  return await response.json().catch(() => ({})) as T & { error?: string };
}

export function SavedViewsPanel({
  workspaceId,
  userId,
  views,
  agents,
  documents,
  canManage,
  canManageAll,
}: {
  workspaceId: string;
  userId: string;
  views: SavedView[];
  agents: WorkspaceAgentSummary[];
  documents: DocumentSummary[];
  canManage: boolean;
  canManageAll: boolean;
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      runFailed: "Could not run the saved view.",
      saveFailed: "Could not save the view.",
      deleteConfirm: "Delete “{name}”? Documents will not be deleted.",
      deleteFailed: "Could not delete the view.",
      savedViews: "Saved views",
      description: "Share reusable document filters with the workspace and its agents.",
      close: "Close",
      views: "Views",
      newView: "New view",
      noViews: "No saved views yet.",
      private: "Only me",
      shared: "Shared",
      deleteView: "Delete {name}",
      createTitle: "Create a saved view",
      viewName: "View name",
      viewPlaceholder: "Example: Gameroom awaiting review",
      documentScope: "Document scope",
      wholeWorkspace: "Entire workspace",
      recentlyUpdated: "Recently updated",
      allTime: "Any time",
      day: "24 hours",
      days7: "7 days",
      days30: "30 days",
      days90: "90 days",
      workflow: "Workflow status",
      allStatuses: "All statuses",
      draft: "Draft",
      review: "Review",
      final: "Final",
      assignedAgent: "Assigned agent",
      allAssignees: "All assignments",
      assignmentRole: "Assignment role",
      allRoles: "All roles",
      owner: "Primary",
      contributor: "Collaborator",
      reviewer: "Reviewer",
      documentType: "Document type",
      typePlaceholder: "Example: game-guide",
      titlePrefix: "Title begins with",
      titlePlaceholder: "Example: [Review]",
      tag: "Tag",
      tagPlaceholder: "Example: live",
      unassignedOnly: "Only documents without an assignment",
      visibility: "Visibility",
      workspaceShared: "Shared with workspace",
      cancel: "Cancel",
      saving: "Saving…",
      saveView: "Save view",
      documentCount: "{count} documents",
      noResults: "No documents match these conditions.",
      welcomeTitle: "Find the documents you need at once.",
      welcomeHint: "Choose a view on the left or save a new set of conditions.",
    },
    ko: {
      runFailed: "저장된 보기를 실행하지 못했습니다.",
      saveFailed: "보기를 저장하지 못했습니다.",
      deleteConfirm: "“{name}” 보기를 삭제할까요? 문서는 삭제되지 않습니다.",
      deleteFailed: "보기를 삭제하지 못했습니다.",
      savedViews: "저장된 보기",
      description: "반복해서 찾는 문서 조건을 워크스페이스와 에이전트가 함께 사용합니다.",
      close: "닫기",
      views: "보기",
      newView: "새 보기",
      noViews: "아직 저장된 보기가 없습니다.",
      private: "나만",
      shared: "공용",
      deleteView: "{name} 삭제",
      createTitle: "새 보기 만들기",
      viewName: "보기 이름",
      viewPlaceholder: "예: Gameroom 검토 대기",
      documentScope: "문서 범위",
      wholeWorkspace: "워크스페이스 전체",
      recentlyUpdated: "최근 수정",
      allTime: "전체 기간",
      day: "24시간",
      days7: "7일",
      days30: "30일",
      days90: "90일",
      workflow: "업무 상태",
      allStatuses: "모든 상태",
      draft: "초안",
      review: "검토",
      final: "확정",
      assignedAgent: "담당 에이전트",
      allAssignees: "모든 담당",
      assignmentRole: "담당 역할",
      allRoles: "모든 역할",
      owner: "주 담당",
      contributor: "공동 작업",
      reviewer: "검토",
      documentType: "문서 유형",
      typePlaceholder: "예: game-guide",
      titlePrefix: "제목 시작",
      titlePlaceholder: "예: [검토]",
      tag: "태그",
      tagPlaceholder: "예: live",
      unassignedOnly: "담당이 없는 문서만",
      visibility: "공개 범위",
      workspaceShared: "워크스페이스 공용",
      cancel: "취소",
      saving: "저장 중…",
      saveView: "보기 저장",
      documentCount: "{count}개 문서",
      noResults: "조건에 맞는 문서가 없습니다.",
      welcomeTitle: "필요한 문서를 한 번에 찾으세요.",
      welcomeHint: "왼쪽에서 보기를 선택하거나 새 조건을 저장할 수 있습니다.",
    },
    ja: {
      runFailed: "保存ビューを実行できませんでした。",
      saveFailed: "ビューを保存できませんでした。",
      deleteConfirm: "「{name}」を削除しますか？文書は削除されません。",
      deleteFailed: "ビューを削除できませんでした。",
      savedViews: "保存ビュー",
      description: "繰り返し使う文書条件をワークスペースとエージェントで共有します。",
      close: "閉じる",
      views: "ビュー",
      newView: "新しいビュー",
      noViews: "保存ビューはまだありません。",
      private: "自分のみ",
      shared: "共有",
      deleteView: "{name}を削除",
      createTitle: "保存ビューを作成",
      viewName: "ビュー名",
      viewPlaceholder: "例：Gameroom レビュー待ち",
      documentScope: "文書範囲",
      wholeWorkspace: "ワークスペース全体",
      recentlyUpdated: "最近の更新",
      allTime: "全期間",
      day: "24時間",
      days7: "7日",
      days30: "30日",
      days90: "90日",
      workflow: "ワークフロー状態",
      allStatuses: "すべての状態",
      draft: "下書き",
      review: "レビュー",
      final: "確定",
      assignedAgent: "担当エージェント",
      allAssignees: "すべての担当",
      assignmentRole: "担当役割",
      allRoles: "すべての役割",
      owner: "主担当",
      contributor: "共同作業",
      reviewer: "レビュー",
      documentType: "文書タイプ",
      typePlaceholder: "例：game-guide",
      titlePrefix: "タイトルの先頭",
      titlePlaceholder: "例：[レビュー]",
      tag: "タグ",
      tagPlaceholder: "例：live",
      unassignedOnly: "担当がない文書のみ",
      visibility: "公開範囲",
      workspaceShared: "ワークスペース共有",
      cancel: "キャンセル",
      saving: "保存中…",
      saveView: "ビューを保存",
      documentCount: "{count}件の文書",
      noResults: "条件に一致する文書はありません。",
      welcomeTitle: "必要な文書を一度に見つけましょう。",
      welcomeHint: "左からビューを選ぶか、新しい条件を保存できます。",
    },
  }[locale];
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<SavedViewResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "workspace">("workspace");
  const [withinDocumentId, setWithinDocumentId] = useState("");
  const [titlePrefix, setTitlePrefix] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [workflowStatus, setWorkflowStatus] = useState<"" | DocumentWorkflowStatus>("");
  const [tag, setTag] = useState("");
  const [updatedWithinDays, setUpdatedWithinDays] = useState("");
  const [assignedAgentId, setAssignedAgentId] = useState("");
  const [assignmentType, setAssignmentType] = useState<"" | AssignmentType>("");
  const [unassigned, setUnassigned] = useState(false);

  function workspaceRequest(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-nyxdoc-workspace-id", workspaceId);
    if (init.body) headers.set("Content-Type", "application/json");
    return fetch(input, { ...init, headers });
  }

  async function runView(viewId: string) {
    if (pending) return;
    setPending(viewId);
    setCreating(false);
    setError("");
    const response = await workspaceRequest(`/api/saved-views/${viewId}/run`);
    const body = await readBody<SavedViewResult>(response);
    setPending(null);
    if (!response.ok) {
      setError(body.error || copy.runFailed);
      return;
    }
    setResult(body);
  }

  async function createView(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const query: SavedViewQuery = {
      ...(withinDocumentId ? { withinDocumentId } : {}),
      ...(titlePrefix.trim() ? { titlePrefix: titlePrefix.trim() } : {}),
      ...(documentType.trim() ? { documentType: documentType.trim() } : {}),
      ...(workflowStatus ? { workflowStatus } : {}),
      ...(tag.trim() ? { tag: tag.trim() } : {}),
      ...(updatedWithinDays ? { updatedWithinDays: Number(updatedWithinDays) } : {}),
      ...(assignedAgentId ? { assignedAgentId } : {}),
      ...(assignmentType ? { assignmentType } : {}),
      ...(unassigned ? { unassigned: true } : {}),
      sort: "updated_desc",
      limit: 100,
    };
    setPending("create");
    setError("");
    const response = await workspaceRequest("/api/saved-views", {
      method: "POST",
      body: JSON.stringify({ name, visibility, query }),
    });
    const body = await readBody<{ view: SavedView }>(response);
    setPending(null);
    if (!response.ok) {
      setError(body.error || copy.saveFailed);
      return;
    }
    setName("");
    setCreating(false);
    router.refresh();
    await runView(body.view.id);
  }

  async function deleteView(view: SavedView) {
    if (pending || !window.confirm(formatCopy(copy.deleteConfirm, { name: view.name }))) return;
    setPending(view.id);
    setError("");
    const response = await workspaceRequest(`/api/saved-views/${view.id}`, { method: "DELETE" });
    const body = await readBody<Record<string, never>>(response);
    setPending(null);
    if (!response.ok) {
      setError(body.error || copy.deleteFailed);
      return;
    }
    if (result?.view.id === view.id) setResult(null);
    router.refresh();
  }

  function navigateToDocument(documentId: string) {
    const query = new URLSearchParams({ workspace: workspaceId, document: documentId });
    setOpen(false);
    router.push(`/app?${query.toString()}`);
  }

  return (
    <>
      <button className={styles.savedViewsButton} type="button" onClick={() => {
        setError("");
        setOpen(true);
      }}>
        <Filter size={15} />
        <span>{copy.savedViews}</span>
        {views.length > 0 && <em>{views.length}</em>}
      </button>

      {open && createPortal((
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !pending) setOpen(false);
        }}>
          <section className={styles.savedViewsDialog} role="dialog" aria-modal="true" aria-labelledby="saved-views-title">
            <header>
              <div>
                <span><Filter size={18} /></span>
                <div><h2 id="saved-views-title">{copy.savedViews}</h2><p>{copy.description}</p></div>
              </div>
              <button type="button" onClick={() => setOpen(false)} disabled={Boolean(pending)} aria-label={copy.close}><X size={18} /></button>
            </header>
            <div className={styles.savedViewsBody}>
              <aside>
                <div className={styles.savedViewsNavHeading}>
                  <span>{copy.views}</span>
                  {canManage && <button type="button" onClick={() => {
                    setCreating(true);
                    setResult(null);
                    setError("");
                  }} title={copy.newView}><Plus size={15} /></button>}
                </div>
                {views.length === 0 && <p>{copy.noViews}</p>}
                {views.map((view) => {
                  const canDelete = view.createdBy.type === "human" && view.createdBy.id === userId
                    || (canManageAll && view.visibility === "workspace");
                  return (
                    <div className={result?.view.id === view.id ? styles.savedViewActive : ""} key={view.id}>
                      <button type="button" onClick={() => runView(view.id)} disabled={Boolean(pending)}>
                        <Search size={14} /><span>{view.name}</span><small>{view.visibility === "private" ? copy.private : copy.shared}</small>
                      </button>
                      {canManage && canDelete && <button type="button" onClick={() => deleteView(view)} disabled={Boolean(pending)} aria-label={formatCopy(copy.deleteView, { name: view.name })}><Trash2 size={13} /></button>}
                    </div>
                  );
                })}
              </aside>

              <main>
                {creating ? (
                  <form className={styles.savedViewForm} onSubmit={createView}>
                    <h3>{copy.createTitle}</h3>
                    <label>{copy.viewName}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus placeholder={copy.viewPlaceholder} /></label>
                    <div className={styles.savedViewFormGrid}>
                      <label>{copy.documentScope}<select value={withinDocumentId} onChange={(event) => setWithinDocumentId(event.target.value)}><option value="">{copy.wholeWorkspace}</option>{documents.map((document) => <option value={document.id} key={document.id}>{document.title}</option>)}</select></label>
                      <label>{copy.recentlyUpdated}<select value={updatedWithinDays} onChange={(event) => setUpdatedWithinDays(event.target.value)}><option value="">{copy.allTime}</option><option value="1">{copy.day}</option><option value="7">{copy.days7}</option><option value="30">{copy.days30}</option><option value="90">{copy.days90}</option></select></label>
                      <label>{copy.workflow}<select value={workflowStatus} onChange={(event) => setWorkflowStatus(event.target.value as "" | DocumentWorkflowStatus)}><option value="">{copy.allStatuses}</option><option value="draft">{copy.draft}</option><option value="review">{copy.review}</option><option value="final">{copy.final}</option></select></label>
                      <label>{copy.assignedAgent}<select value={assignedAgentId} onChange={(event) => {
                        setAssignedAgentId(event.target.value);
                        if (event.target.value) setUnassigned(false);
                      }}><option value="">{copy.allAssignees}</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}</select></label>
                      <label>{copy.assignmentRole}<select value={assignmentType} onChange={(event) => setAssignmentType(event.target.value as "" | AssignmentType)}><option value="">{copy.allRoles}</option><option value="owner">{copy.owner}</option><option value="contributor">{copy.contributor}</option><option value="reviewer">{copy.reviewer}</option></select></label>
                      <label>{copy.documentType}<input value={documentType} onChange={(event) => setDocumentType(event.target.value)} maxLength={80} placeholder={copy.typePlaceholder} /></label>
                      <label>{copy.titlePrefix}<input value={titlePrefix} onChange={(event) => setTitlePrefix(event.target.value)} maxLength={200} placeholder={copy.titlePlaceholder} /></label>
                      <label>{copy.tag}<input value={tag} onChange={(event) => setTag(event.target.value)} maxLength={50} placeholder={copy.tagPlaceholder} /></label>
                    </div>
                    <label className={styles.savedViewCheckbox}><input type="checkbox" checked={unassigned} onChange={(event) => {
                      setUnassigned(event.target.checked);
                      if (event.target.checked) setAssignedAgentId("");
                    }} /> {copy.unassignedOnly}</label>
                    <label>{copy.visibility}<select value={visibility} onChange={(event) => setVisibility(event.target.value as "private" | "workspace")}><option value="workspace">{copy.workspaceShared}</option><option value="private">{copy.private}</option></select></label>
                    <div className={styles.savedViewFormActions}><button type="button" onClick={() => setCreating(false)}>{copy.cancel}</button><button type="submit" disabled={!name.trim() || Boolean(pending)}>{pending === "create" ? copy.saving : copy.saveView}</button></div>
                  </form>
                ) : result ? (
                  <div className={styles.savedViewResults}>
                    <header><div><h3>{result.view.name}</h3><p>{formatCopy(copy.documentCount, { count: result.total })}</p></div></header>
                    {result.documents.length === 0 ? <p className={styles.emptySavedView}>{copy.noResults}</p> : result.documents.map((document) => (
                      <button type="button" key={document.id} onClick={() => navigateToDocument(document.id)}>
                        <span><FileText size={15} /></span>
                        <div><strong>{document.title}</strong><small>{document.path.map((item) => item.title).join(" / ")}</small></div>
                        {document.assignments.length > 0 && <span className={styles.savedViewResultAvatars}>{document.assignments.slice(0, 3).map((assignment) => <UserAvatar key={assignment.id} className={styles.savedViewResultAvatar} imageUrl={assignment.agentAvatarMediaId ? `/api/media/${assignment.agentAvatarMediaId}` : null} name={assignment.agentDisplayName} />)}</span>}
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className={styles.savedViewWelcome}><Filter size={28} /><h3>{copy.welcomeTitle}</h3><p>{copy.welcomeHint}</p></div>
                )}
                {error && <div className={styles.savedViewError} role="alert">{error}</div>}
              </main>
            </div>
          </section>
        </div>
      ), document.body)}
    </>
  );
}
