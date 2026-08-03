"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  Building2,
  Check,
  Copy,
  KeyRound,
  PencilLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { UserAvatar } from "@/components/profile/user-avatar";
import { DocumentScopePicker } from "@/components/settings/document-scope-picker";
import { buildAgentConnectionHandoff } from "@/lib/agents/handoff";
import { uploadMediaFile } from "@/lib/media/client";
import { useI18n } from "@/lib/i18n/client";
import { formatCopy } from "@/lib/i18n/copy";
import { localeTag, type AppLocale } from "@/lib/i18n/locales";
import type {
  AccountAgentSummary,
  AgentCredentialSummary,
  AgentWorkspaceMembershipSummary,
  ConnectAgentToWorkspaceResult,
} from "@/lib/agents/service";
import {
  AGENT_ACCESS_PROFILES,
  listAgentProfilePermissions,
  type AgentAccessProfile,
  type WorkspacePermission,
} from "@/lib/authz/permissions";
import type { ApiTokenScope } from "@/lib/tokens/service";
import type { DocumentSummary } from "@/lib/documents/types";
import type { WorkspaceSummary } from "@/lib/workspaces/service";
import styles from "./settings.module.css";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
function credentialDate(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function delegablePermissions(locale: AppLocale): Array<{
  value: WorkspacePermission;
  label: string;
  description: string;
}> {
  const copy = {
    en: {
      workspace: ["Read workspace information", "View the name, operational policy, and other basic information."],
      members: ["Read human members", "View the human members of the workspace."],
      agents: ["Read agents", "View assigned agents and their status."],
      credentials: ["Read connection status", "View connection status without secret values."],
      documentRead: ["Read documents", "Read canonical revisions and drafts within the allowed document scope."],
      documentCreate: ["Create documents", "Create new documents and child documents."],
      documentUpdate: ["Edit drafts", "Edit shared drafts."],
      documentCommit: ["Save canonical revisions", "Commit a reviewed draft as a new revision."],
      documentTrashOwn: ["Trash own documents", "Move only document trees entirely created by this agent to trash."],
      documentTrash: ["Move documents to trash", "Safely trash document trees."],
      documentRestore: ["Restore from trash", "Restore deleted document trees."],
      revisionRead: ["Read revisions", "View past revisions and differences."],
      revisionRestore: ["Restore revisions", "Load a past revision into the shared draft."],
      changes: ["Read change feed", "Track new canonical revisions in the workspace."],
      savedViewRead: ["Read saved views", "Use saved document searches in the workspace."],
      assignmentManage: ["Manage assignments", "Manage agent responsibilities and progress."],
      assignmentRead: ["Read assignments", "View assigned agents and progress for each document."],
      savedViewManage: ["Manage saved views", "Manage reusable workspace search filters."],
      requestRead: ["Read administration requests", "View management requests and human review results."],
      audit: ["Read audit records", "View workspace operations records."],
      requestCreate: ["Create administration requests", "Propose management changes that require human approval."],
      media: ["Upload images", "Upload images used in documents."],
      export: ["Export documents", "Create Markdown and Nyxdoc bundles."],
    },
    ko: {
      workspace: ["워크스페이스 정보 읽기", "이름과 운영 정책 등 기본 정보를 확인합니다."],
      members: ["사람 멤버 읽기", "워크스페이스의 사람 멤버를 확인합니다."],
      agents: ["에이전트 읽기", "함께 배정된 에이전트와 상태를 확인합니다."],
      credentials: ["연결 상태 읽기", "비밀 원문을 제외한 연결 상태를 확인합니다."],
      documentRead: ["문서 읽기", "허용된 문서 범위의 정본과 초안을 읽습니다."],
      documentCreate: ["문서 만들기", "새 문서와 하위 문서를 만듭니다."],
      documentUpdate: ["초안 편집", "공유 초안을 편집합니다."],
      documentCommit: ["정본 저장", "검토한 초안을 새 리비전으로 확정합니다."],
      documentTrashOwn: ["내가 만든 문서 삭제", "이 에이전트가 모두 만든 문서 트리만 휴지통으로 옮깁니다."],
      documentTrash: ["휴지통으로 이동", "문서 트리를 안전하게 삭제합니다."],
      documentRestore: ["휴지통 복구", "삭제된 문서 트리를 복원합니다."],
      revisionRead: ["리비전 읽기", "문서의 과거 리비전과 변경 차이를 확인합니다."],
      revisionRestore: ["리비전 복원", "과거 리비전을 공유 초안으로 불러옵니다."],
      changes: ["변경 피드 읽기", "워크스페이스의 새 정본 변경을 추적합니다."],
      savedViewRead: ["저장 필터 읽기", "워크스페이스의 저장된 검색 보기를 사용합니다."],
      assignmentManage: ["담당 관리", "에이전트 담당과 진행 상태를 관리합니다."],
      assignmentRead: ["담당 읽기", "문서별 담당 에이전트와 진행 상태를 확인합니다."],
      savedViewManage: ["저장 필터 관리", "워크스페이스 검색 필터를 관리합니다."],
      requestRead: ["관리 요청 읽기", "관리 작업 요청과 사람의 검토 결과를 확인합니다."],
      audit: ["감사 기록 읽기", "워크스페이스 운영 기록을 확인합니다."],
      requestCreate: ["관리 작업 요청", "사람의 승인이 필요한 관리 작업을 제안합니다."],
      media: ["이미지 업로드", "문서에 사용할 이미지를 업로드합니다."],
      export: ["문서 내보내기", "Markdown과 Nyxdoc 번들을 만듭니다."],
    },
    ja: {
      workspace: ["ワークスペース情報を読む", "名前や運用ポリシーなどの基本情報を確認します。"],
      members: ["人のメンバーを読む", "ワークスペースの人のメンバーを確認します。"],
      agents: ["エージェントを読む", "割り当てられたエージェントと状態を確認します。"],
      credentials: ["接続状態を読む", "秘密値を除く接続状態を確認します。"],
      documentRead: ["文書を読む", "許可された文書範囲の正本と下書きを読みます。"],
      documentCreate: ["文書を作成", "新しい文書と子文書を作成します。"],
      documentUpdate: ["下書きを編集", "共有下書きを編集します。"],
      documentCommit: ["正本を保存", "確認済みの下書きを新しいリビジョンとして確定します。"],
      documentTrashOwn: ["自分が作成した文書を削除", "このエージェントがすべて作成した文書ツリーのみゴミ箱へ移動します。"],
      documentTrash: ["ゴミ箱へ移動", "文書ツリーを安全に削除します。"],
      documentRestore: ["ゴミ箱から復元", "削除された文書ツリーを復元します。"],
      revisionRead: ["リビジョンを読む", "過去のリビジョンと差分を確認します。"],
      revisionRestore: ["リビジョンを復元", "過去のリビジョンを共有下書きへ読み込みます。"],
      changes: ["変更フィードを読む", "ワークスペースの新しい正本変更を追跡します。"],
      savedViewRead: ["保存ビューを読む", "ワークスペースの保存済み検索を使用します。"],
      assignmentManage: ["担当を管理", "エージェントの担当と進捗を管理します。"],
      assignmentRead: ["担当を読む", "文書ごとの担当エージェントと進捗を確認します。"],
      savedViewManage: ["保存ビューを管理", "再利用可能な検索フィルターを管理します。"],
      requestRead: ["管理リクエストを読む", "管理リクエストと人の確認結果を表示します。"],
      audit: ["監査記録を読む", "ワークスペースの運用記録を確認します。"],
      requestCreate: ["管理リクエストを作成", "人の承認が必要な管理変更を提案します。"],
      media: ["画像をアップロード", "文書で使用する画像をアップロードします。"],
      export: ["文書を書き出す", "MarkdownとNyxdocバンドルを作成します。"],
    },
  }[locale];
  const row = (
    value: WorkspacePermission,
    text: string[],
  ) => ({ value, label: text[0], description: text[1] });
  return [
    row("workspace.read", copy.workspace),
    row("members.read", copy.members),
    row("agents.read", copy.agents),
    row("credentials.read", copy.credentials),
    row("documents.read", copy.documentRead),
    row("documents.create", copy.documentCreate),
    row("documents.update", copy.documentUpdate),
    row("documents.commit", copy.documentCommit),
    row("documents.trash_own", copy.documentTrashOwn),
    row("documents.trash", copy.documentTrash),
    row("documents.restore", copy.documentRestore),
    row("revisions.read", copy.revisionRead),
    row("revisions.restore", copy.revisionRestore),
    row("changes.read", copy.changes),
    row("saved_views.read", copy.savedViewRead),
    row("assignments.manage", copy.assignmentManage),
    row("assignments.read", copy.assignmentRead),
    row("saved_views.manage", copy.savedViewManage),
    row("admin_requests.read", copy.requestRead),
    row("audit.read", copy.audit),
    row("admin_requests.create", copy.requestCreate),
    row("media.upload", copy.media),
    row("exports.create", copy.export),
  ];
}

type ApiBody = { error?: string };

function accessProfileLabel(profile: AgentAccessProfile, locale: AppLocale) {
  return {
    en: {
      reader: "Reader · read only",
      drafter: "Drafter · edit drafts",
      writer: "Writer · edit and save",
      custom: "Custom access",
    },
    ko: {
      reader: "읽기 · 읽기 전용",
      drafter: "초안 작성 · 초안 편집",
      writer: "문서 작업 · 편집 및 저장",
      custom: "사용자 지정 권한",
    },
    ja: {
      reader: "閲覧 · 読み取り専用",
      drafter: "下書き作成 · 下書き編集",
      writer: "文書作業 · 編集と保存",
      custom: "カスタムアクセス",
    },
  }[locale][profile];
}

function humanRoleLabel(role: WorkspaceSummary["role"], locale: AppLocale) {
  return {
    en: { owner: "Owner", admin: "Administrator", editor: "Editor", viewer: "Viewer" },
    ko: { owner: "소유자", admin: "관리자", editor: "편집자", viewer: "뷰어" },
    ja: { owner: "所有者", admin: "管理者", editor: "編集者", viewer: "閲覧者" },
  }[locale][role];
}

function canManageWorkspaceAgents(role: WorkspaceSummary["role"]) {
  return role === "owner" || role === "admin";
}

function dateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function credentialScopes(mode: "read" | "write", restore: boolean): ApiTokenScope[] {
  if (mode === "read") return ["documents:read", "changes:read"];
  return [
    "documents:read",
    "documents:write",
    "documents:commit",
    "changes:read",
    ...(restore ? ["revisions:restore" as const] : []),
  ];
}

function requestError(body: ApiBody, fallback: string) {
  return body.error || fallback;
}

export function AccountAgentsPanel({
  collectionEndpoint = "/api/account/agents",
  initialAgents,
  mcpUrl,
  uploadWorkspaceId,
  workspaces,
}: {
  collectionEndpoint?: string;
  initialAgents: AccountAgentSummary[];
  mcpUrl: string;
  uploadWorkspaceId: string;
  workspaces: WorkspaceSummary[];
}) {
  const { locale } = useI18n();
  const copy = {
    en: {
      createFailed: "Could not register the agent.",
      updateFailed: "Could not update the agent.",
      avatarRequirement: "Use a PNG, JPEG, GIF, or WebP avatar no larger than 5 MB.",
      avatarFailed: "Could not save the avatar.",
      defaultKey: "{name} default key",
      workspaceRestrictionRequired: "Select at least one workspace when workspace restrictions are enabled.",
      keySaveFailed: "Could not save the connection key.",
      rotateConfirm: "Rotate {name}? The current key will be revoked immediately.",
      rotateFailed: "Could not rotate the connection key.",
      revokeConfirm: "Revoke {name}? This cannot be undone.",
      revokeFailed: "Could not revoke the connection key.",
      deleteFailed: "Could not delete the agent.",
      restoreFailed: "Could not restore the agent.",
      purgeFailed: "Could not permanently delete the agent.",
      identities: "Agent identities",
      identitiesDescription: "Register an agent once in your account, then assign different roles and document scopes in each workspace.",
      newAgentName: "New agent name",
      agentPlaceholder: "Example: gameroom-main",
      register: "Register agent",
      noAgents: "No agents have been registered.",
      avatarChange: "Change agent avatar",
      agentName: "Agent name",
      saveAgentName: "Save agent name",
      cancelAgentName: "Cancel agent rename",
      renameAgent: "Rename {name}",
      workspacesAndKeys: "{workspaces} workspaces · {keys} active keys",
      assignmentPermissions: "Assignments and permissions",
      activeStateAction: "active; press to disable",
      disabledStateAction: "disabled; press to enable",
      activeStateTitle: "Currently active. Press to disable.",
      disabledStateTitle: "Currently disabled. Press to enable.",
      disableConfirm: "Disable {name}? Assignments in every workspace will also stop.",
      active: "Active",
      disabled: "Disabled",
      delete: "Delete",
      membership: "{workspace} · {role}",
      noAssignments: "No workspace assignments yet. Assign now",
      registeredAgents: "Registered agents",
      connectionKeys: "Connection keys",
      credentialsDescription: "Create keys for external agents and manage expiry, IP limits, and workspace limits.",
      activeKeysIdentity: "{keys} active keys · {identity}",
      activeIdentity: "active identity",
      disabledIdentity: "disabled identity",
      createKey: "Create key",
      noKeys: "No active connection keys.",
      lastUsed: "Last used {date}",
      neverUsed: "Not used yet",
      ipLimit: "IP limit: {ips}",
      noIpLimit: "No IP limit",
      workspaceLimit: "Attached to {count} workspace grants",
      allAssignedWorkspaces: "No workspace access attached",
      keySettings: "Key settings",
      rotateKey: "Rotate key",
      revokeKey: "Revoke key",
      endpointHint: "MCP URL · the URL workspace is only a fallback default; tools can target every allowed workspace",
      copyAddress: "Copy address",
      deletedAgents: "Deleted agents",
      deletedDescription: "Restore an identity within 30 days. Permanent deletion creates a final backup and then removes it beyond recovery.",
      noDeletedAgents: "No deleted agents.",
      deletedTimeline: "Deleted {deleted} · recoverable until {purge}",
      deletedImpact: "Connection keys were revoked and workspace assignments and responsibilities were stopped.",
      restoring: "Restoring…",
      restore: "Restore",
      permanentDelete: "Permanently delete",
      deleteTitle: "Delete {name}",
      deleteDescription: "All connection keys are revoked immediately and workspace assignments stop. The same identity can be restored within 30 days, but old keys and assignments are not restored automatically.",
      historySafe: "Past records remain safe.",
      historySafeDescription: "Names and icons captured in document revisions and audit records remain after deletion.",
      cancel: "Cancel",
      deleting: "Deleting…",
      deleteAgent: "Delete agent",
      purgeTitle: "Permanently delete {name}",
      purgeDescription: "After verifying a final backup, connection keys and retry state are fully removed. This cannot be undone in the UI, and the identity cannot be restored.",
      documentsRemain: "Documents and past author labels are not deleted.",
      documentsRemainDescription: "Names and icons captured in revisions and audit records are retained to preserve record integrity.",
      typeToConfirm: "Enter {name} to confirm.",
      purging: "Backing up and deleting…",
      keyEditor: "Connection key settings",
      newKey: "Create a connection key",
      keyBoundary: "A key authenticates an agent identity. Effective permissions and document scope come from each workspace assignment.",
      keyName: "Key name",
      keyCeiling: "Key permission ceiling",
      readOnly: "Read only",
      readWriteCommit: "Read, write, and save canonical revisions",
      defaultWorkspace: "Default workspace",
      noDefault: "No default · choose with every request",
      noAssignedWorkspace: "No assigned workspaces",
      assignFirstGroup: "Assign the agent first to make these selectable",
      unassigned: "Unassigned",
      noDefaultHint: "MCP requests can specify a workspace even when no default is set.",
      expiry: "Expiration (optional)",
      allowRevisionRestore: "Allow revision restore",
      revisionRestoreHint: "The workspace permission must also allow restore.",
      workspaceRestriction: "Workspace access bindings",
      restrictedHint: "The key can access only explicitly selected workspace grants. Saving never changes the grants themselves.",
      assignBeforeRestrict: "Assign the agent to a workspace before restricting it.",
      assignFirst: "Assign the agent to a workspace first.",
      noUsableWorkspace: "This key cannot use any workspace yet. Assign the agent, then choose a role and document scope.",
      viewAssignments: "View assignments and permissions",
      allowedIp: "Allowed IP/CIDR (optional)",
      ipHint: "Leave empty for no IP restriction. Enter the public source IP observed by the server.",
      saving: "Saving…",
      save: "Save",
      assignmentTitle: "{name} assignments and permissions",
      assignmentsDescription: "Register an agent once, then assign different roles and document scopes in multiple workspaces.",
      myRole: "my role",
      permissions: "Permission settings",
      startConnection: "Start connection",
      noManagePermission: "No management permission",
      adminRolePreserved: "The workspace administrator role remains bounded.",
      adminBoundary: "It can manage document work, assignments, filters, audit, and requests; key issuance and privilege elevation remain behind human approval.",
      close: "Close",
      knownAgent: "Registered agent",
      allDocuments: "All documents",
      subtree: "{title} and descendants",
      keyReady: "The connection key is ready.",
      keyShownOnce: "The raw key is shown only once. Store it in the agent’s secret store.",
      handoffTitle: "Send this directly to the agent",
      handoffHint: "Copy the guide below and paste it into the private conversation with the agent you use.",
      handoffCopied: "Full guide copied",
      copyHandoff: "Copy agent connection guide",
      handoffSecret: "The guide contains the connection key. Paste it only into a trusted agent’s private conversation.",
      directSetup: "Information for manual setup",
      copied: "Copied",
      copyKey: "Copy key",
      stored: "Saved",
    },
    ko: {
      createFailed: "에이전트를 등록하지 못했습니다.",
      updateFailed: "에이전트를 수정하지 못했습니다.",
      avatarRequirement: "아바타는 5MB 이하 PNG, JPEG, GIF 또는 WebP 파일을 사용해주세요.",
      avatarFailed: "아바타를 저장하지 못했습니다.",
      defaultKey: "{name} 기본 키",
      workspaceRestrictionRequired: "워크스페이스 제한을 사용하려면 한 곳 이상 선택해주세요.",
      keySaveFailed: "연결 키를 저장하지 못했습니다.",
      rotateConfirm: "{name}을 회전할까요? 기존 키는 즉시 폐기됩니다.",
      rotateFailed: "연결 키를 회전하지 못했습니다.",
      revokeConfirm: "{name}을 폐기할까요? 이 작업은 되돌릴 수 없습니다.",
      revokeFailed: "연결 키를 폐기하지 못했습니다.",
      deleteFailed: "에이전트를 삭제하지 못했습니다.",
      restoreFailed: "에이전트를 복구하지 못했습니다.",
      purgeFailed: "에이전트를 영구 삭제하지 못했습니다.",
      identities: "에이전트 신원",
      identitiesDescription: "에이전트는 계정에 한 번 등록하고, 워크스페이스마다 별도의 역할과 문서 범위로 배정합니다.",
      newAgentName: "새 에이전트 이름",
      agentPlaceholder: "예: gameroom-main",
      register: "에이전트 등록",
      noAgents: "등록된 에이전트가 없습니다.",
      avatarChange: "에이전트 아바타 변경",
      agentName: "에이전트 이름",
      saveAgentName: "에이전트 이름 저장",
      cancelAgentName: "에이전트 이름 수정 취소",
      renameAgent: "{name} 이름 변경",
      workspacesAndKeys: "{workspaces}개 워크스페이스 · {keys}개 활성 키",
      assignmentPermissions: "배정·권한",
      activeStateAction: "활성 상태, 누르면 비활성 상태로 변경",
      disabledStateAction: "비활성 상태, 누르면 활성 상태로 변경",
      activeStateTitle: "현재 활성 상태입니다. 누르면 비활성 상태로 변경됩니다.",
      disabledStateTitle: "현재 비활성 상태입니다. 누르면 활성 상태로 변경됩니다.",
      disableConfirm: "{name} 에이전트를 비활성화할까요? 모든 워크스페이스 할당이 함께 중지됩니다.",
      active: "활성 상태",
      disabled: "비활성 상태",
      delete: "삭제",
      membership: "{workspace} · {role}",
      noAssignments: "아직 할당된 워크스페이스가 없습니다. 배정하기",
      registeredAgents: "등록된 에이전트",
      connectionKeys: "연결 키",
      credentialsDescription: "외부 에이전트가 Nyxdoc에 접속할 때 사용할 키를 만들고, 만료·IP·워크스페이스 상한을 관리합니다.",
      activeKeysIdentity: "{keys}개 활성 키 · {identity}",
      activeIdentity: "활성 신원",
      disabledIdentity: "비활성 신원",
      createKey: "키 만들기",
      noKeys: "활성 연결 키가 없습니다.",
      lastUsed: "최근 사용 {date}",
      neverUsed: "아직 사용 전",
      ipLimit: "IP 제한 {ips}",
      noIpLimit: "IP 제한 없음",
      workspaceLimit: "워크스페이스 접근 권한 {count}개에 연결",
      allAssignedWorkspaces: "연결된 워크스페이스 접근 권한 없음",
      keySettings: "키 설정",
      rotateKey: "키 회전",
      revokeKey: "키 폐기",
      endpointHint: "MCP 주소 · 주소의 워크스페이스는 기본값일 뿐이며 도구에서 허용된 다른 워크스페이스를 지정할 수 있음",
      copyAddress: "주소 복사",
      deletedAgents: "삭제된 에이전트",
      deletedDescription: "30일 안에는 신원을 복구할 수 있습니다. 영구 삭제하면 삭제 직전 백업을 만든 뒤 복구할 수 없는 상태로 정리합니다.",
      noDeletedAgents: "삭제된 에이전트가 없습니다.",
      deletedTimeline: "{deleted} 삭제 · {purge}까지 복구 가능",
      deletedImpact: "연결 키는 폐기되었고 워크스페이스 할당과 담당은 중지되었습니다.",
      restoring: "복구 중…",
      restore: "복구",
      permanentDelete: "영구 삭제",
      deleteTitle: "{name} 삭제",
      deleteDescription: "모든 연결 키가 즉시 폐기되고 워크스페이스 할당이 중지됩니다. 30일 안에는 같은 신원으로 복구할 수 있지만, 기존 키와 할당은 자동으로 되살아나지 않습니다.",
      historySafe: "과거 기록은 안전하게 남습니다.",
      historySafeDescription: "문서 리비전과 감사 기록의 당시 이름·아이콘은 삭제 후에도 유지됩니다.",
      cancel: "취소",
      deleting: "삭제 중…",
      deleteAgent: "에이전트 삭제",
      purgeTitle: "{name} 영구 삭제",
      purgeDescription: "삭제 직전 백업을 검증한 뒤 연결 키와 재시도 상태를 완전히 제거합니다. 이 작업은 화면에서 되돌릴 수 없으며, 에이전트 신원을 다시 복구할 수 없습니다.",
      documentsRemain: "문서와 과거 작성자 표시는 삭제되지 않습니다.",
      documentsRemainDescription: "문서 리비전·감사 기록의 당시 이름과 아이콘은 기록의 무결성을 위해 보존됩니다.",
      typeToConfirm: "확인하려면 {name}을 입력하세요.",
      purging: "백업 후 삭제 중…",
      keyEditor: "연결 키 설정",
      newKey: "새 연결 키 만들기",
      keyBoundary: "키는 에이전트 신원을 인증합니다. 실제 권한과 문서 범위는 각 워크스페이스의 배정·권한 설정에서 결정됩니다.",
      keyName: "키 이름",
      keyCeiling: "키 권한 상한",
      readOnly: "읽기 전용",
      readWriteCommit: "읽기·쓰기·정본 저장",
      defaultWorkspace: "기본 워크스페이스",
      noDefault: "기본값 없음 · 요청마다 선택",
      noAssignedWorkspace: "배정된 워크스페이스 없음",
      assignFirstGroup: "먼저 에이전트를 배정해야 선택 가능",
      unassigned: "미배정",
      noDefaultHint: "기본값이 없어도 MCP 요청에서 워크스페이스를 명시할 수 있습니다.",
      expiry: "만료일 (선택)",
      allowRevisionRestore: "리비전 복원 허용",
      revisionRestoreHint: "워크스페이스 권한도 복원을 허용해야 실제로 동작합니다.",
      workspaceRestriction: "워크스페이스 접근 권한 연결",
      restrictedHint: "명시적으로 선택한 워크스페이스 접근 권한에서만 이 키를 사용할 수 있습니다. 키를 저장해도 접근 권한 자체는 바뀌지 않습니다.",
      assignBeforeRestrict: "워크스페이스에 배정한 뒤 제한할 수 있습니다.",
      assignFirst: "먼저 워크스페이스에 배정해주세요.",
      noUsableWorkspace: "현재 키를 사용할 수 있는 워크스페이스가 없습니다. 에이전트를 배정한 뒤 역할과 문서 범위를 정할 수 있습니다.",
      viewAssignments: "배정·권한 보기",
      allowedIp: "허용 IP/CIDR (선택)",
      ipHint: "비워두면 IP 제한이 없습니다. 서버에서 관찰되는 공인 출발 IP를 입력하세요.",
      saving: "저장 중…",
      save: "저장",
      assignmentTitle: "{name}의 배정·권한",
      assignmentsDescription: "에이전트는 계정에 한 번 등록하고, 여러 워크스페이스에 각각 다른 역할과 문서 범위로 배정합니다.",
      myRole: "내 권한",
      permissions: "권한 설정",
      startConnection: "연결 시작",
      noManagePermission: "관리 권한 없음",
      adminRolePreserved: "워크스페이스 관리자 역할은 유지됩니다.",
      adminBoundary: "문서 작업·담당·필터·감사·관리 요청을 수행하며, 키 발급과 권한 상승은 사람 승인 경계를 유지합니다.",
      close: "닫기",
      knownAgent: "등록된 에이전트",
      allDocuments: "모든 문서",
      subtree: "{title} 이하",
      keyReady: "연결 키가 준비됐습니다.",
      keyShownOnce: "원문은 지금 한 번만 표시됩니다. 에이전트의 비밀 저장소에 보관하세요.",
      handoffTitle: "에이전트에게 바로 전달하세요",
      handoffHint: "아래 버튼을 누른 뒤 사용하는 에이전트의 대화창에 그대로 붙여넣으면 됩니다.",
      handoffCopied: "안내 전체가 복사됐습니다",
      copyHandoff: "에이전트 연결 안내 전체 복사",
      handoffSecret: "연결 키가 포함됩니다. 신뢰하는 에이전트의 비공개 대화에만 붙여넣으세요.",
      directSetup: "직접 설정할 때 사용할 정보",
      copied: "복사됨",
      copyKey: "키 복사",
      stored: "저장했습니다",
    },
    ja: {
      createFailed: "エージェントを登録できませんでした。",
      updateFailed: "エージェントを更新できませんでした。",
      avatarRequirement: "アバターは5MB以下のPNG、JPEG、GIF、WebPを使用してください。",
      avatarFailed: "アバターを保存できませんでした。",
      defaultKey: "{name}の既定キー",
      workspaceRestrictionRequired: "ワークスペース制限を有効にする場合は1つ以上選択してください。",
      keySaveFailed: "接続キーを保存できませんでした。",
      rotateConfirm: "{name}をローテーションしますか？現在のキーは直ちに失効します。",
      rotateFailed: "接続キーをローテーションできませんでした。",
      revokeConfirm: "{name}を失効しますか？この操作は元に戻せません。",
      revokeFailed: "接続キーを失効できませんでした。",
      deleteFailed: "エージェントを削除できませんでした。",
      restoreFailed: "エージェントを復元できませんでした。",
      purgeFailed: "エージェントを完全削除できませんでした。",
      identities: "エージェントID",
      identitiesDescription: "エージェントはアカウントへ一度登録し、ワークスペースごとに異なる役割と文書範囲を割り当てます。",
      newAgentName: "新しいエージェント名",
      agentPlaceholder: "例：gameroom-main",
      register: "エージェントを登録",
      noAgents: "登録されたエージェントはありません。",
      avatarChange: "エージェントのアバターを変更",
      agentName: "エージェント名",
      saveAgentName: "エージェント名を保存",
      cancelAgentName: "名前変更をキャンセル",
      renameAgent: "{name}の名前を変更",
      workspacesAndKeys: "{workspaces}ワークスペース · 有効なキー{keys}件",
      assignmentPermissions: "割り当てと権限",
      activeStateAction: "有効。押すと無効に変更",
      disabledStateAction: "無効。押すと有効に変更",
      activeStateTitle: "現在は有効です。押すと無効になります。",
      disabledStateTitle: "現在は無効です。押すと有効になります。",
      disableConfirm: "{name}を無効にしますか？すべてのワークスペース割り当ても停止します。",
      active: "有効",
      disabled: "無効",
      delete: "削除",
      membership: "{workspace} · {role}",
      noAssignments: "ワークスペースへの割り当てがありません。割り当てる",
      registeredAgents: "登録済みエージェント",
      connectionKeys: "接続キー",
      credentialsDescription: "外部エージェント用のキーを作成し、有効期限、IP、ワークスペース上限を管理します。",
      activeKeysIdentity: "有効なキー{keys}件 · {identity}",
      activeIdentity: "有効なID",
      disabledIdentity: "無効なID",
      createKey: "キーを作成",
      noKeys: "有効な接続キーはありません。",
      lastUsed: "最終使用 {date}",
      neverUsed: "未使用",
      ipLimit: "IP制限 {ips}",
      noIpLimit: "IP制限なし",
      workspaceLimit: "ワークスペースアクセス{count}件に関連付け",
      allAssignedWorkspaces: "関連付けられたワークスペースアクセスなし",
      keySettings: "キー設定",
      rotateKey: "キーローテーション",
      revokeKey: "キーを失効",
      endpointHint: "MCP URL · URLのワークスペースは既定値にすぎず、ツールから許可済みの別ワークスペースを指定可能",
      copyAddress: "URLをコピー",
      deletedAgents: "削除されたエージェント",
      deletedDescription: "30日以内ならIDを復元できます。完全削除では最終バックアップ後、復元不能な状態まで削除します。",
      noDeletedAgents: "削除されたエージェントはありません。",
      deletedTimeline: "{deleted}に削除 · {purge}まで復元可能",
      deletedImpact: "接続キーは失効し、ワークスペース割り当てと担当は停止しました。",
      restoring: "復元中…",
      restore: "復元",
      permanentDelete: "完全削除",
      deleteTitle: "{name}を削除",
      deleteDescription: "すべての接続キーは直ちに失効し、ワークスペース割り当ては停止します。30日以内なら同じIDを復元できますが、以前のキーと割り当ては自動復元されません。",
      historySafe: "過去の記録は安全に保持されます。",
      historySafeDescription: "文書リビジョンと監査記録に保存された名前とアイコンは削除後も残ります。",
      cancel: "キャンセル",
      deleting: "削除中…",
      deleteAgent: "エージェントを削除",
      purgeTitle: "{name}を完全削除",
      purgeDescription: "最終バックアップを検証した後、接続キーと再試行状態を完全に削除します。この操作は画面から元に戻せず、IDも復元できません。",
      documentsRemain: "文書と過去の作成者表示は削除されません。",
      documentsRemainDescription: "記録の完全性を保つため、リビジョンと監査記録に保存された名前とアイコンは保持されます。",
      typeToConfirm: "確認するには{name}と入力してください。",
      purging: "バックアップ後に削除中…",
      keyEditor: "接続キー設定",
      newKey: "新しい接続キーを作成",
      keyBoundary: "キーはエージェントIDを認証します。実効権限と文書範囲は各ワークスペースの割り当てで決まります。",
      keyName: "キー名",
      keyCeiling: "キー権限の上限",
      readOnly: "読み取り専用",
      readWriteCommit: "読み取り・書き込み・正本保存",
      defaultWorkspace: "既定のワークスペース",
      noDefault: "既定値なし · リクエストごとに選択",
      noAssignedWorkspace: "割り当て済みワークスペースなし",
      assignFirstGroup: "先にエージェントを割り当てると選択できます",
      unassigned: "未割り当て",
      noDefaultHint: "既定値がなくてもMCPリクエストでワークスペースを指定できます。",
      expiry: "有効期限（任意）",
      allowRevisionRestore: "リビジョン復元を許可",
      revisionRestoreHint: "ワークスペース権限でも復元が許可されている必要があります。",
      workspaceRestriction: "ワークスペースアクセスの関連付け",
      restrictedHint: "明示的に選択したワークスペース権限でのみこのキーを使用できます。キー保存で権限自体は変更されません。",
      assignBeforeRestrict: "ワークスペースへ割り当てた後に制限できます。",
      assignFirst: "先にワークスペースへ割り当ててください。",
      noUsableWorkspace: "このキーを使用できるワークスペースがありません。エージェントを割り当て、役割と文書範囲を設定してください。",
      viewAssignments: "割り当てと権限を表示",
      allowedIp: "許可IP/CIDR（任意）",
      ipHint: "空欄ならIP制限なしです。サーバーから見える公開送信元IPを入力してください。",
      saving: "保存中…",
      save: "保存",
      assignmentTitle: "{name}の割り当てと権限",
      assignmentsDescription: "エージェントはアカウントへ一度登録し、複数ワークスペースへ異なる役割と文書範囲で割り当てます。",
      myRole: "自分の権限",
      permissions: "権限設定",
      startConnection: "接続を開始",
      noManagePermission: "管理権限なし",
      adminRolePreserved: "ワークスペース管理者の境界は維持されます。",
      adminBoundary: "文書作業、担当、フィルター、監査、管理リクエストを扱えますが、キー発行と権限昇格は人の承認が必要です。",
      close: "閉じる",
      knownAgent: "登録済みエージェント",
      allDocuments: "すべての文書",
      subtree: "{title} 以下",
      keyReady: "接続キーの準備ができました。",
      keyShownOnce: "キー原文は今回だけ表示されます。エージェントのシークレットストアへ保存してください。",
      handoffTitle: "エージェントへそのまま渡してください",
      handoffHint: "下のボタンでガイドをコピーし、利用するエージェントの非公開会話へ貼り付けます。",
      handoffCopied: "ガイド全体をコピーしました",
      copyHandoff: "エージェント接続ガイドをコピー",
      handoffSecret: "ガイドには接続キーが含まれます。信頼できるエージェントの非公開会話にだけ貼り付けてください。",
      directSetup: "手動設定用の情報",
      copied: "コピーしました",
      copyKey: "キーをコピー",
      stored: "保存しました",
    },
  }[locale];
  const [agents, setAgents] = useState(initialAgents);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editingAgentName, setEditingAgentName] = useState("");
  const [workspaceManagerAgentId, setWorkspaceManagerAgentId] = useState<string | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<AccountAgentSummary | null>(null);
  const [purgingAgent, setPurgingAgent] = useState<AccountAgentSummary | null>(null);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [revealedConnection, setRevealedConnection] = useState<{
    agentId: string;
    credential: AgentCredentialSummary;
    token: string;
  } | null>(null);
  const [copied, setCopied] = useState<"handoff" | "token" | "url" | null>(null);
  const [credentialEditor, setCredentialEditor] = useState<{
    agent: AccountAgentSummary;
    credential: AgentCredentialSummary | null;
  } | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyMode, setKeyMode] = useState<"read" | "write">("write");
  const [keyRestore, setKeyRestore] = useState(false);
  const [keyDefaultWorkspace, setKeyDefaultWorkspace] = useState("");
  const [keyWorkspaces, setKeyWorkspaces] = useState<string[]>([]);
  const [keyIps, setKeyIps] = useState("");
  const [keyExpiresAt, setKeyExpiresAt] = useState("");

  function replaceAgent(agent: AccountAgentSummary) {
    setAgents((current) => current.map((item) => item.id === agent.id ? agent : item));
  }

  function replaceCredential(agentId: string, credential: AgentCredentialSummary) {
    setAgents((current) => current.map((agent) => agent.id !== agentId ? agent : {
      ...agent,
      credentials: [
        credential,
        ...agent.credentials.filter((item) => item.id !== credential.id),
      ],
    }));
  }

  async function createAgent() {
    if (!newName.trim() || pending) return;
    setPending("create-agent");
    setError("");
    try {
      const response = await fetch(collectionEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: newName }),
      });
      const body = await response.json() as ApiBody & { agent?: AccountAgentSummary };
      if (!response.ok || !body.agent) throw new Error(requestError(body, copy.createFailed));
      setAgents((current) => [...current, body.agent!]);
      setNewName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.createFailed);
    } finally {
      setPending(null);
    }
  }

  async function updateAgent(agent: AccountAgentSummary, changes: Record<string, unknown>) {
    setPending(agent.id);
    setError("");
    try {
      const response = await fetch(`/api/account/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      const body = await response.json() as ApiBody & { agent?: AccountAgentSummary };
      if (!response.ok || !body.agent) throw new Error(requestError(body, copy.updateFailed));
      replaceAgent(body.agent);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.updateFailed);
      return false;
    } finally {
      setPending(null);
    }
  }

  function beginRenameAgent(agent: AccountAgentSummary) {
    setEditingAgentId(agent.id);
    setEditingAgentName(agent.displayName);
    setError("");
  }

  function cancelRenameAgent() {
    setEditingAgentId(null);
    setEditingAgentName("");
  }

  async function saveAgentName(agent: AccountAgentSummary) {
    const displayName = editingAgentName.trim();
    if (!displayName) return;
    if (displayName === agent.displayName) {
      cancelRenameAgent();
      return;
    }
    if (await updateAgent(agent, { displayName })) cancelRenameAgent();
  }

  async function chooseAvatar(agent: AccountAgentSummary, file: File | undefined) {
    if (!file || pending) return;
    if (!AVATAR_TYPES.has(file.type) || file.size > MAX_AVATAR_BYTES) {
      setError(copy.avatarRequirement);
      return;
    }
    setPending(agent.id);
    setError("");
    try {
      const media = await uploadMediaFile(file, uploadWorkspaceId);
      const response = await fetch(`/api/account/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avatarMediaId: media.id }),
      });
      const body = await response.json() as ApiBody & { agent?: AccountAgentSummary };
      if (!response.ok || !body.agent) throw new Error(requestError(body, copy.avatarFailed));
      replaceAgent(body.agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.avatarFailed);
    } finally {
      setPending(null);
    }
  }

  function openCredentialEditor(agent: AccountAgentSummary, credential: AgentCredentialSummary | null) {
    setCredentialEditor({ agent, credential });
    setKeyName(credential?.name ?? formatCopy(copy.defaultKey, { name: agent.displayName }));
    setKeyMode(credential?.scopes.includes("documents:write") === false ? "read" : "write");
    setKeyRestore(Boolean(credential?.scopes.includes("revisions:restore")));
    setKeyDefaultWorkspace(credential?.defaultWorkspaceId ?? "");
    setKeyWorkspaces(credential?.workspaceIds ?? []);
    setKeyIps(credential?.ipAllowlist.join("\n") ?? "");
    setKeyExpiresAt(dateTimeLocal(credential?.expiresAt ?? null));
    setError("");
  }

  async function saveCredential() {
    if (!credentialEditor || pending) return;
    const { agent, credential } = credentialEditor;
    const payload = {
      name: keyName,
      scopes: credentialScopes(keyMode, keyMode === "write" && keyRestore),
      defaultWorkspaceId: keyDefaultWorkspace || null,
      workspaceIds: keyWorkspaces,
      ipAllowlist: keyIps.split(/[\s,]+/).filter(Boolean),
      expiresAt: keyExpiresAt ? new Date(keyExpiresAt).toISOString() : null,
    };
    setPending(credential?.id ?? `new:${agent.id}`);
    setError("");
    try {
      const url = credential
        ? `/api/account/agents/${agent.id}/credentials/${credential.id}`
        : `/api/account/agents/${agent.id}/credentials`;
      const response = await fetch(url, {
        method: credential ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as ApiBody & {
        token?: string;
        credential?: AgentCredentialSummary;
      };
      if (!response.ok || !body.credential) throw new Error(requestError(body, copy.keySaveFailed));
      replaceCredential(agent.id, body.credential);
      setCredentialEditor(null);
      if (body.token) {
        setCopied(null);
        setRevealedConnection({
          agentId: agent.id,
          credential: body.credential,
          token: body.token,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.keySaveFailed);
    } finally {
      setPending(null);
    }
  }

  async function rotateCredential(agent: AccountAgentSummary, credential: AgentCredentialSummary) {
    if (!window.confirm(formatCopy(copy.rotateConfirm, { name: credential.name }))) return;
    setPending(credential.id);
    setError("");
    try {
      const response = await fetch(`/api/account/agents/${agent.id}/credentials/${credential.id}/rotate`, { method: "POST" });
      const body = await response.json() as ApiBody & { token?: string; credential?: AgentCredentialSummary };
      if (!response.ok || !body.credential || !body.token) throw new Error(requestError(body, copy.rotateFailed));
      setAgents((current) => current.map((item) => item.id !== agent.id ? item : {
        ...item,
        credentials: [body.credential!, ...item.credentials.filter((key) => key.id !== credential.id)],
      }));
      setCopied(null);
      setRevealedConnection({
        agentId: agent.id,
        credential: body.credential,
        token: body.token,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.rotateFailed);
    } finally {
      setPending(null);
    }
  }

  async function revokeCredential(agent: AccountAgentSummary, credential: AgentCredentialSummary) {
    if (!window.confirm(formatCopy(copy.revokeConfirm, { name: credential.name }))) return;
    setPending(credential.id);
    setError("");
    try {
      const response = await fetch(`/api/account/agents/${agent.id}/credentials/${credential.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json() as ApiBody;
        throw new Error(requestError(body, copy.revokeFailed));
      }
      setAgents((current) => current.map((item) => item.id !== agent.id ? item : {
        ...item,
        credentials: item.credentials.filter((key) => key.id !== credential.id),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.revokeFailed);
    } finally {
      setPending(null);
    }
  }

  async function deleteAgent(agent: AccountAgentSummary) {
    if (pending) return;
    setPending(`delete:${agent.id}`);
    setError("");
    try {
      const response = await fetch(`/api/account/agents/${agent.id}`, { method: "DELETE" });
      const body = await response.json() as ApiBody & { agent?: AccountAgentSummary };
      if (!response.ok || !body.agent) {
        throw new Error(requestError(body, copy.deleteFailed));
      }
      replaceAgent(body.agent);
      setDeletingAgent(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.deleteFailed);
    } finally {
      setPending(null);
    }
  }

  async function restoreAgent(agent: AccountAgentSummary) {
    if (pending) return;
    setPending(`restore:${agent.id}`);
    setError("");
    try {
      const response = await fetch(`/api/account/agents/${agent.id}/restore`, { method: "POST" });
      const body = await response.json() as ApiBody & { agent?: AccountAgentSummary };
      if (!response.ok || !body.agent) {
        throw new Error(requestError(body, copy.restoreFailed));
      }
      replaceAgent(body.agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.restoreFailed);
    } finally {
      setPending(null);
    }
  }

  async function purgeAgent(agent: AccountAgentSummary) {
    if (pending || purgeConfirmation.trim() !== agent.displayName) return;
    setPending(`purge:${agent.id}`);
    setError("");
    try {
      const response = await fetch(`/api/account/agents/${agent.id}/purge`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationName: purgeConfirmation }),
      });
      const body = await response.json() as ApiBody & { agent?: AccountAgentSummary };
      if (!response.ok || !body.agent) {
        throw new Error(requestError(body, copy.purgeFailed));
      }
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      setPurgingAgent(null);
      setPurgeConfirmation("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.purgeFailed);
    } finally {
      setPending(null);
    }
  }

  const activeAgents = agents.filter((agent) => !agent.deletedAt);
  const deletedAgents = agents.filter((agent) => Boolean(agent.deletedAt) && !agent.purgedAt);
  const workspaceManagerAgent = agents.find((agent) => agent.id === workspaceManagerAgentId) ?? null;
  const credentialAgent = credentialEditor
    ? agents.find((agent) => agent.id === credentialEditor.agent.id) ?? credentialEditor.agent
    : null;
  const credentialMemberships = credentialAgent?.memberships.filter((membership) => membership.status === "active") ?? [];
  const credentialMembershipIds = new Set(credentialMemberships.map((membership) => membership.workspaceId));
  const unassignedCredentialWorkspaces = workspaces.filter((workspace) => !credentialMembershipIds.has(workspace.id));

  return <>
    <section className={styles.settingsCard} id="agent-identities">
      <div className={styles.sectionHeading}>
        <span className={styles.connectionIcon}><UserRound size={18} /></span>
        <div>
          <h2>{copy.identities}</h2>
          <p>{copy.identitiesDescription}</p>
        </div>
      </div>
      <div className={styles.agentCreateRow}>
        <label><span>{copy.newAgentName}</span><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={copy.agentPlaceholder} maxLength={80} /></label>
        <button type="button" onClick={() => void createAgent()} disabled={Boolean(pending) || !newName.trim()}><Plus size={15} /> {copy.register}</button>
      </div>
      <div className={styles.globalAgentList}>
        {activeAgents.length === 0 ? <div className={styles.emptyTokens}>{copy.noAgents}</div> : activeAgents.map((agent) => {
          const activeCredentials = agent.credentials.filter((credential) => !credential.revokedAt);
          const activeMemberships = agent.memberships.filter((membership) => membership.status === "active");
          return <article className={styles.globalAgentCard} key={agent.id}>
            <header>
              <label className={styles.agentAvatarButton} title={copy.avatarChange}>
                <UserAvatar className={styles.agentAvatar} imageUrl={agent.avatarMediaId ? `/api/media/${agent.avatarMediaId}` : null} name={agent.displayName} />
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={pending === agent.id} onChange={(event) => { void chooseAvatar(agent, event.target.files?.[0]); event.currentTarget.value = ""; }} />
              </label>
              <div className={styles.agentIdentity}>
                {editingAgentId === agent.id ? <div className={styles.agentNameEditor}>
                  <input
                    autoFocus
                    aria-label={copy.agentName}
                    value={editingAgentName}
                    maxLength={80}
                    disabled={pending === agent.id}
                    onChange={(event) => setEditingAgentName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveAgentName(agent);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRenameAgent();
                      }
                    }}
                  />
                  <button type="button" onClick={() => void saveAgentName(agent)} disabled={!editingAgentName.trim() || pending === agent.id} aria-label={copy.saveAgentName}><Check size={14} /></button>
                  <button type="button" onClick={cancelRenameAgent} disabled={pending === agent.id} aria-label={copy.cancelAgentName}><X size={14} /></button>
                </div> : <span className={styles.agentNameRow}>
                  <strong>{agent.displayName}</strong>
                  <button type="button" onClick={() => beginRenameAgent(agent)} aria-label={formatCopy(copy.renameAgent, { name: agent.displayName })}><PencilLine size={13} /></button>
                </span>}
                <small>{formatCopy(copy.workspacesAndKeys, {
                  workspaces: activeMemberships.length,
                  keys: activeCredentials.length,
                })}</small>
              </div>
              <div className={styles.agentHeaderActions}>
                <button type="button" className={styles.secondaryButton} onClick={() => setWorkspaceManagerAgentId(agent.id)}><Building2 size={14} /> {copy.assignmentPermissions}</button>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${styles.agentStatusButton} ${
                    agent.status === "active" ? styles.agentStatusActive : styles.agentStatusDisabled
                  }`}
                  aria-pressed={agent.status === "active"}
                  aria-label={`${agent.displayName} ${agent.status === "active"
                    ? copy.activeStateAction
                    : copy.disabledStateAction}`}
                  title={agent.status === "active"
                    ? copy.activeStateTitle
                    : copy.disabledStateTitle}
                  onClick={() => {
                    const nextStatus = agent.status === "active" ? "disabled" : "active";
                    if (nextStatus === "disabled" && !window.confirm(formatCopy(
                      copy.disableConfirm,
                      { name: agent.displayName },
                    ))) return;
                    void updateAgent(agent, { status: nextStatus });
                  }}
                >{agent.status === "active" ? copy.active : copy.disabled}</button>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${styles.deleteAgentButton}`}
                  onClick={() => {
                    setError("");
                    setDeletingAgent(agent);
                  }}
                ><Trash2 size={14} /> {copy.delete}</button>
              </div>
            </header>
            <div className={styles.membershipChips}>
              {activeMemberships.length
                ? activeMemberships.map((membership) => <Link href={`/settings/workspace?workspace=${encodeURIComponent(membership.workspaceId)}#workspace-agents`} key={membership.membershipId}>{formatCopy(copy.membership, {
                  workspace: membership.workspaceName,
                  role: accessProfileLabel(membership.accessProfile, locale),
                })}</Link>)
                : <button type="button" onClick={() => setWorkspaceManagerAgentId(agent.id)}>{copy.noAssignments}</button>}
            </div>
          </article>;
        })}
      </div>
    </section>

    <section className={styles.settingsCard} id="agent-credentials">
      <div className={styles.sectionHeading}>
        <span className={styles.connectionIcon}><KeyRound size={18} /></span>
        <div>
          <h2>{copy.connectionKeys}</h2>
          <p>{copy.credentialsDescription}</p>
        </div>
      </div>
      <div className={styles.credentialAgentGroups}>
        {activeAgents.length === 0
          ? <div className={styles.emptyTokens}>{copy.noAgents}</div>
          : activeAgents.map((agent) => {
            const activeCredentials = agent.credentials.filter((credential) => !credential.revokedAt);
            return <article className={styles.credentialAgentGroup} key={agent.id}>
              <header>
                <UserAvatar className={styles.agentAvatar} imageUrl={agent.avatarMediaId ? `/api/media/${agent.avatarMediaId}` : null} name={agent.displayName} />
                <div>
                  <strong>{agent.displayName}</strong>
                  <small>{formatCopy(copy.activeKeysIdentity, {
                    keys: activeCredentials.length,
                    identity: agent.status === "active"
                      ? copy.activeIdentity
                      : copy.disabledIdentity,
                  })}</small>
                </div>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => openCredentialEditor(agent, null)}
                  disabled={agent.status !== "active"}
                ><Plus size={14} /> {copy.createKey}</button>
              </header>
              <div className={styles.credentialList}>
                {activeCredentials.length === 0 ? <small>{copy.noKeys}</small> : activeCredentials.map((credential) => <div className={styles.credentialRow} key={credential.id}>
                  <div>
                    <strong>{credential.name}</strong>
                    <small>
                      {credential.prefix}… · {credential.lastUsedAt
                        ? formatCopy(copy.lastUsed, {
                          date: credentialDate(credential.lastUsedAt, locale),
                        })
                        : copy.neverUsed}
                      {credential.lastUsedIp ? ` · ${credential.lastUsedIp}` : ""}
                    </small>
                    <small>
                      {credential.ipAllowlist.length
                        ? formatCopy(copy.ipLimit, {
                          ips: credential.ipAllowlist.join(", "),
                        })
                        : copy.noIpLimit}
                      {" · "}
                      {credential.workspaceIds.length
                        ? formatCopy(copy.workspaceLimit, {
                          count: credential.workspaceIds.length,
                        })
                        : copy.allAssignedWorkspaces}
                    </small>
                  </div>
                  <div><button type="button" onClick={() => openCredentialEditor(agent, credential)} title={copy.keySettings}><Settings2 size={14} /></button><button type="button" onClick={() => void rotateCredential(agent, credential)} title={copy.rotateKey}><RefreshCw size={14} /></button><button type="button" onClick={() => void revokeCredential(agent, credential)} title={copy.revokeKey}><Trash2 size={14} /></button></div>
                </div>)}
              </div>
            </article>;
          })}
      </div>
      <div className={styles.endpointBox}><div><span>{copy.endpointHint}</span><code>{mcpUrl}</code></div><button type="button" onClick={() => void navigator.clipboard.writeText(mcpUrl)}><Copy size={14} /> {copy.copyAddress}</button></div>
    </section>

    <section className={styles.settingsCard} id="deleted-agents">
      <div className={styles.sectionHeading}>
        <span className={styles.deletedSectionIcon}><Trash2 size={18} /></span>
        <div>
          <h2>{copy.deletedAgents}</h2>
          <p>{copy.deletedDescription}</p>
        </div>
      </div>
      {deletedAgents.length === 0
        ? <div className={styles.emptyTokens}>{copy.noDeletedAgents}</div>
        : <div className={styles.deletedAgentList}>
          {deletedAgents.map((agent) => <article className={styles.deletedAgentRow} key={agent.id}>
            <UserAvatar
              className={styles.agentAvatar}
              imageUrl={agent.avatarMediaId ? `/api/media/${agent.avatarMediaId}` : null}
              name={agent.displayName}
            />
            <div>
              <strong>{agent.displayName}</strong>
              <small>{formatCopy(copy.deletedTimeline, {
                deleted: agent.deletedAt ? credentialDate(agent.deletedAt, locale) : "",
                purge: agent.purgeAfter ? credentialDate(agent.purgeAfter, locale) : "",
              })}</small>
              <small>{copy.deletedImpact}</small>
            </div>
            <div className={styles.deletedAgentActions}>
              <button
                type="button"
                onClick={() => void restoreAgent(agent)}
                disabled={pending === `restore:${agent.id}`}
              ><RotateCcw size={14} /> {pending === `restore:${agent.id}` ? copy.restoring : copy.restore}</button>
              <button
                type="button"
                className={styles.purgeAgentButton}
                onClick={() => {
                  setError("");
                  setPurgeConfirmation("");
                  setPurgingAgent(agent);
                }}
                disabled={Boolean(pending)}
              ><Trash2 size={14} /> {copy.permanentDelete}</button>
            </div>
          </article>)}
        </div>}
    </section>
    {error && !deletingAgent && !purgingAgent && !credentialEditor && <div className={styles.inlineError} role="alert">{error}</div>}

    {deletingAgent && <div className={styles.modalBackdrop} role="presentation">
      <section className={`${styles.connectionEditModal} ${styles.deleteAgentModal}`} role="dialog" aria-modal="true" aria-labelledby="delete-agent-title">
        <div className={styles.connectionEditIcon}><Trash2 size={20} /></div>
        <p>DELETE AGENT</p>
        <h2 id="delete-agent-title">{formatCopy(copy.deleteTitle, { name: deletingAgent.displayName })}</h2>
        <span>{copy.deleteDescription}</span>
        <div className={styles.deleteAgentImpact}>
          <strong>{copy.historySafe}</strong>
          <small>{copy.historySafeDescription}</small>
        </div>
        {error && <div className={styles.inlineError} role="alert">{error}</div>}
        <footer>
          <button type="button" onClick={() => { setDeletingAgent(null); setError(""); }} disabled={Boolean(pending)}>{copy.cancel}</button>
          <button
            type="button"
            className={styles.confirmDeleteAgentButton}
            onClick={() => void deleteAgent(deletingAgent)}
            disabled={Boolean(pending)}
          ><Trash2 size={14} /> {pending === `delete:${deletingAgent.id}` ? copy.deleting : copy.deleteAgent}</button>
        </footer>
      </section>
    </div>}

    {purgingAgent && <div className={styles.modalBackdrop} role="presentation">
      <section className={`${styles.connectionEditModal} ${styles.deleteAgentModal}`} role="dialog" aria-modal="true" aria-labelledby="purge-agent-title">
        <div className={styles.connectionEditIcon}><Trash2 size={20} /></div>
        <p>PERMANENTLY DELETE AGENT</p>
        <h2 id="purge-agent-title">{formatCopy(copy.purgeTitle, { name: purgingAgent.displayName })}</h2>
        <span>{copy.purgeDescription}</span>
        <div className={styles.deleteAgentImpact}>
          <strong>{copy.documentsRemain}</strong>
          <small>{copy.documentsRemainDescription}</small>
        </div>
        <label className={styles.purgeConfirmationField}>
          <span>{formatCopy(copy.typeToConfirm, { name: purgingAgent.displayName })}</span>
          <input
            autoFocus
            value={purgeConfirmation}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => setPurgeConfirmation(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && purgeConfirmation.trim() === purgingAgent.displayName) {
                event.preventDefault();
                void purgeAgent(purgingAgent);
              }
            }}
          />
        </label>
        {error && <div className={styles.inlineError} role="alert">{error}</div>}
        <footer>
          <button
            type="button"
            onClick={() => {
              setPurgingAgent(null);
              setPurgeConfirmation("");
              setError("");
            }}
            disabled={Boolean(pending)}
          >{copy.cancel}</button>
          <button
            type="button"
            className={styles.confirmDeleteAgentButton}
            onClick={() => void purgeAgent(purgingAgent)}
            disabled={Boolean(pending) || purgeConfirmation.trim() !== purgingAgent.displayName}
          ><Trash2 size={14} /> {pending === `purge:${purgingAgent.id}` ? copy.purging : copy.permanentDelete}</button>
        </footer>
      </section>
    </div>}

    {credentialEditor && <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.connectionEditModal} role="dialog" aria-modal="true" aria-labelledby="credential-editor-title">
        <div className={styles.connectionEditIcon}><KeyRound size={20} /></div>
        <p>AGENT CREDENTIAL</p>
        <h2 id="credential-editor-title">{credentialEditor.credential ? copy.keyEditor : copy.newKey}</h2>
        <span>{copy.keyBoundary}</span>
        <div className={styles.credentialEditorGrid}>
          <label><span>{copy.keyName}</span><input value={keyName} onChange={(event) => setKeyName(event.target.value)} maxLength={80} /></label>
          <label><span>{copy.keyCeiling}</span><select value={keyMode} onChange={(event) => setKeyMode(event.target.value as "read" | "write")}><option value="read">{copy.readOnly}</option><option value="write">{copy.readWriteCommit}</option></select></label>
          <label>
            <span>{copy.defaultWorkspace}</span>
            <select value={keyDefaultWorkspace} onChange={(event) => setKeyDefaultWorkspace(event.target.value)}>
              <option value="">{credentialMemberships.length ? copy.noDefault : copy.noAssignedWorkspace}</option>
              {credentialMemberships.filter((membership) => keyWorkspaces.includes(membership.workspaceId)).map((membership) => <option key={membership.workspaceId} value={membership.workspaceId}>{membership.workspaceName}</option>)}
              {unassignedCredentialWorkspaces.length > 0 && <optgroup label={copy.assignFirstGroup}>
                {unassignedCredentialWorkspaces.map((workspace) => <option disabled value={`unassigned:${workspace.id}`} key={workspace.id}>{workspace.name} · {copy.unassigned}</option>)}
              </optgroup>}
            </select>
            <small className={styles.fieldHelp}>{copy.noDefaultHint}</small>
          </label>
          <label><span>{copy.expiry}</span><input type="datetime-local" value={keyExpiresAt} onChange={(event) => setKeyExpiresAt(event.target.value)} /></label>
          <label className={styles.editPermissionToggle}><input type="checkbox" checked={keyMode === "write" && keyRestore} disabled={keyMode === "read"} onChange={(event) => setKeyRestore(event.target.checked)} /><span><strong>{copy.allowRevisionRestore}</strong><small>{copy.revisionRestoreHint}</small></span></label>
          <div className={styles.editPermissionToggle}><span><strong>{copy.workspaceRestriction}</strong><small>{credentialMemberships.length ? copy.restrictedHint : copy.assignBeforeRestrict}</small></span></div>
          {credentialMemberships.length > 0 && <div className={styles.workspaceChecklist}>{credentialMemberships.map((membership) => <label key={membership.workspaceId}><input type="checkbox" checked={keyWorkspaces.includes(membership.workspaceId)} onChange={(event) => {
            setKeyWorkspaces((current) => event.target.checked ? [...new Set([...current, membership.workspaceId])] : current.filter((id) => id !== membership.workspaceId));
            if (!event.target.checked && keyDefaultWorkspace === membership.workspaceId) setKeyDefaultWorkspace("");
          }} /><span>{membership.workspaceName}</span></label>)}</div>}
          {credentialMemberships.length === 0 && credentialAgent && <div className={styles.credentialWorkspaceNotice}>
            <Building2 size={17} />
            <div><strong>{copy.assignFirst}</strong><small>{copy.noUsableWorkspace}</small></div>
            <button type="button" onClick={() => { setCredentialEditor(null); setWorkspaceManagerAgentId(credentialAgent.id); }}>{copy.viewAssignments} <ArrowRight size={13} /></button>
          </div>}
          <label className={styles.fullWidthField}><span>{copy.allowedIp}</span><textarea value={keyIps} onChange={(event) => setKeyIps(event.target.value)} placeholder={"203.0.113.10\n2001:db8::/48"} /><small>{copy.ipHint}</small></label>
        </div>
        {error && <div className={styles.inlineError} role="alert">{error}</div>}
        <footer><button type="button" onClick={() => { setCredentialEditor(null); setError(""); }} disabled={Boolean(pending)}>{copy.cancel}</button><button type="button" onClick={() => void saveCredential()} disabled={Boolean(pending) || !keyName.trim()}><Save size={14} /> {pending ? copy.saving : copy.save}</button></footer>
      </section>
    </div>}

    {workspaceManagerAgent && <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.workspaceAssignmentModal} role="dialog" aria-modal="true" aria-labelledby="workspace-assignment-title">
        <div className={styles.connectionEditIcon}><Building2 size={20} /></div>
        <p>WORKSPACE ASSIGNMENTS</p>
        <h2 id="workspace-assignment-title">{formatCopy(copy.assignmentTitle, { name: workspaceManagerAgent.displayName })}</h2>
        <span>{copy.assignmentsDescription}</span>
        <div className={styles.workspaceAssignmentList}>
          {workspaces.map((workspace) => {
            const membership = workspaceManagerAgent.memberships.find((item) => item.workspaceId === workspace.id && item.status === "active");
            const canManage = canManageWorkspaceAgents(workspace.role);
            return <article key={workspace.id}>
              <span><Building2 size={16} /></span>
              <div>
                <strong>{workspace.name}</strong>
                <small>{membership ? accessProfileLabel(membership.accessProfile, locale) : copy.unassigned} · {copy.myRole} {humanRoleLabel(workspace.role, locale)}</small>
              </div>
              {canManage
                ? <Link href={membership
                  ? `/settings/workspace?workspace=${encodeURIComponent(workspace.id)}#workspace-agents`
                  : `/settings/workspace?workspace=${encodeURIComponent(workspace.id)}&connectAgent=1#workspace-agents`
                }>{membership ? copy.permissions : copy.startConnection} <ArrowRight size={13} /></Link>
                : <em>{copy.noManagePermission}</em>}
            </article>;
          })}
        </div>
        <div className={styles.workspaceAssignmentBoundary}>
          <ShieldCheck size={16} />
          <span><strong>{copy.adminRolePreserved}</strong><small>{copy.adminBoundary}</small></span>
        </div>
        <footer><button type="button" onClick={() => setWorkspaceManagerAgentId(null)}>{copy.close}</button></footer>
      </section>
    </div>}

    {revealedConnection && (() => {
      const revealedAgent = agents.find((agent) => agent.id === revealedConnection.agentId);
      const defaultWorkspace = workspaces.find(
        (workspace) => workspace.id === revealedConnection.credential.defaultWorkspaceId,
      );
      const defaultMembership = revealedAgent?.memberships.find(
        (membership) => membership.workspaceId === defaultWorkspace?.id && membership.status === "active",
      );
      const revealedMcpUrl = defaultWorkspace
        ? workspaceMcpUrl(mcpUrl, defaultWorkspace.id)
        : mcpUrl;
      const handoff = buildAgentConnectionHandoff({
        agentName: revealedAgent?.displayName ?? copy.knownAgent,
        credentialName: revealedConnection.credential.name,
        documentScope: defaultMembership
          ? defaultMembership.rootDocumentTitle
            ? formatCopy(copy.subtree, { title: defaultMembership.rootDocumentTitle })
            : copy.allDocuments
          : null,
        keyAccess: revealedConnection.credential.scopes.includes("documents:write")
          ? copy.readWriteCommit
          : copy.readOnly,
        locale,
        mcpUrl: revealedMcpUrl,
        role: defaultMembership ? accessProfileLabel(defaultMembership.accessProfile, locale) : null,
        token: revealedConnection.token,
        workspaceName: defaultWorkspace?.name ?? null,
      });
      return <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.tokenModal} role="dialog" aria-modal="true" aria-labelledby="revealed-token-title">
        <div className={styles.tokenSuccess}><Check size={20} /></div><p>AGENT KEY CREATED</p><h2 id="revealed-token-title">{copy.keyReady}</h2><span>{copy.keyShownOnce}</span>
        <div className={styles.agentHandoffCard}>
          <div className={styles.agentHandoffHeading}><span><Bot size={18} /></span><div><strong>{copy.handoffTitle}</strong><small>{copy.handoffHint}</small></div></div>
          <button type="button" onClick={async () => { await navigator.clipboard.writeText(handoff); setCopied("handoff"); }}><Copy size={15} /> {copied === "handoff" ? copy.handoffCopied : copy.copyHandoff}</button>
          <em>{copy.handoffSecret}</em>
        </div>
        <div className={styles.connectionDirectDetails}>
          <strong>{copy.directSetup}</strong>
          <div className={styles.configBox}><pre>{revealedMcpUrl}</pre><button type="button" onClick={async () => { await navigator.clipboard.writeText(revealedMcpUrl); setCopied("url"); }}><Copy size={14} /> {copied === "url" ? copy.copied : copy.copyAddress}</button></div>
          <div className={styles.secretBox}><code>{revealedConnection.token}</code><button type="button" onClick={async () => { await navigator.clipboard.writeText(revealedConnection.token); setCopied("token"); }}><Copy size={14} /> {copied === "token" ? copy.copied : copy.copyKey}</button></div>
        </div>
        <button className={styles.doneButton} type="button" onClick={() => { setRevealedConnection(null); setCopied(null); }}>{copy.stored}</button>
      </section>
    </div>;
    })()}
  </>;
}

type ConnectionWizardStep = "identity" | "access" | "credential" | "complete";

function activeCredential(credential: AgentCredentialSummary) {
  return !credential.revokedAt
    && (!credential.expiresAt || Date.parse(credential.expiresAt) > Date.now());
}

function workspaceMcpUrl(mcpUrl: string, workspaceId: string) {
  try {
    const url = new URL(mcpUrl);
    url.searchParams.set("workspace", workspaceId);
    return url.toString();
  } catch {
    return `${mcpUrl}${mcpUrl.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspaceId)}`;
  }
}

function workspaceAgentCopy(locale: AppLocale) {
  return {
    en: {
      keySuffix: "connection key",
      existingKeyPlaceholder: "<existing connection key>",
      subtree: "{title} and descendants",
      allDocuments: "All documents",
      connectFailed: "Could not connect the agent.",
      permissionSaveFailed: "Could not save workspace permissions.",
      title: "Agent access",
      description: "Grant an agent access to this workspace, then optionally attach a connection key.",
      connectAgent: "Connect agent",
      identityBoundaryTitle: "Identities and keys are registered once per account.",
      identityBoundary: "Reuse the same agent across workspaces, while granting separate access and document scope in each workspace. Keys are attached explicitly and are never expanded automatically.",
      emptyTitle: "No agents are connected yet.",
      emptyHint: "Choose an existing agent or register a new one and connect it now.",
      firstConnection: "Connect the first agent",
      membershipSummary: "{role} · {scope}",
      keyPermissionSummary: "{keys} connection keys · {permissions} effective permissions",
      permissionSettings: "Permission settings",
      ready: "The connection is ready.",
      connectTitle: "Connect an agent to {workspace}",
      closeWizard: "Close agent connection",
      progressLabel: "Agent connection steps",
      stepAgent: "Agent",
      stepAccess: "Access and scope",
      stepCredential: "Connection key",
      chooseAgent: "Who should be connected to this workspace?",
      chooseAgentHint: "Select an existing agent without registering it again.",
      identityMode: "Agent identity selection",
      existingAgent: "Existing agent",
      registerNewAgent: "Register new agent",
      agentMetrics: "{keys} active keys · {workspaces} other workspaces",
      noExistingAgent: "No existing agent is available. Register a new agent.",
      agentName: "Agent name",
      agentPlaceholder: "Example: nyxdoc-builder",
      agentNameHint: "Use a unique, human-readable name. You can change it later.",
      chooseWork: "Choose what this agent may do in the workspace.",
      chooseWorkHint: "The access profile is the workspace grant. Document scope covers the selected document and all descendants.",
      reader: "Reader",
      readerDescription: "Read and search documents and inspect changes",
      drafter: "Drafter",
      drafterDescription: "Create and edit shared drafts without saving canonical revisions",
      writer: "Writer",
      writerDescription: "Create, edit, and save canonical document revisions",
      viewer: "Viewer",
      viewerDescription: "Read and search documents and inspect changes",
      editor: "Editor",
      editorDescription: "Create, edit, and save documents",
      admin: "Workspace administrator",
      adminDescription: "Manage document work, assignments, filters, audit, and requests",
      documentScope: "Document scope",
      newAgentScope: "Document scope for the new agent",
      scopeHint: "The default is every document in this workspace.",
      chooseKey: "Choose a connection key for the external agent.",
      chooseKeyHint: "This step only attaches a key to the workspace grant. It never widens the key’s scopes or other bindings.",
      readWrite: "Read and write",
      readOnly: "Read only",
      ipLimited: "IP limited",
      expandScope: "selecting adds {workspace} to the allowed workspaces",
      inadequateRole: "Insufficient key permissions",
      noCompatibleKey: "No existing key supports the selected role, so a new key is required.",
      createKey: "Create a connection key",
      keyShownOnce: "The raw value is shown only once after creation.",
      keyName: "Key name",
      existingKeyBoundary: "This key keeps its current scopes. If they are narrower than the workspace grant, the effective authority is reduced.",
      bindLater: "Attach a key later",
      bindLaterHint: "Save workspace access now. The agent cannot connect to this workspace until a key or OAuth credential is attached.",
      accessSavedNoKey: "Workspace access was saved without a connection key. Attach a key from Agent management when the agent is ready to connect.",
      restrictKey: "Limit this key to this workspace",
      restrictKeyHint: "When off, this key can also be used in other workspaces assigned to the agent later.",
      expandExistingKey: "The existing restrictions remain, and only {workspace} is added to the allowed workspaces.",
      effectiveBoundary: "Effective authority is the intersection of the active agent, key scopes, this workspace grant, explicit key binding, and document scope.",
      workspace: "Workspace",
      agent: "Agent",
      role: "Access profile",
      scope: "Document scope",
      handoffTitle: "Now send this to the agent",
      handoffHint: "Paste it into the agent conversation to provide connection information and verification steps together.",
      handoffCopied: "Full guide copied",
      copyHandoff: "Copy agent connection guide",
      copyHandoffWithoutKey: "Copy guide · existing key excluded",
      secretWarning: "The guide contains a connection key. Paste it only into a trusted agent’s private conversation.",
      existingSecretWarning: "The raw value of an existing key cannot be shown again, so it is excluded. The agent will use its stored {name} key.",
      keyOnce: "Connection key · shown only once",
      copied: "Copied",
      copyKey: "Copy key",
      continueKey: "Continue using {name}.",
      existingKeyHint: "The raw value cannot be shown again. Use the value already stored by the agent.",
      manualSetup: "Manual setup · MCP URL and app examples",
      scopedUrl: "MCP URL with a default workspace",
      scopedUrlHint: "This URL sets only the fallback default. Resource IDs and workspaceId can route tools to any other allowed workspace.",
      copyAddress: "Copy address",
      codexConfig: "Codex configuration",
      openClawConfig: "OpenClaw configuration",
      copy: "Copy",
      expandedAllowlist: "{workspace} was added to the existing key’s allowed workspaces.",
      done: "Done",
      connectLater: "Connect later",
      cancel: "Cancel",
      previous: "Previous",
      next: "Next",
      connecting: "Connecting…",
      membershipDescription: "Workspace access and credential limits are independent. Changing this grant never widens a connection key.",
      roleBundle: "Access profile",
      agentScope: "Agent document scope",
      fineTune: "Customize capabilities",
      inherit: "Role default",
      allow: "Allow additionally",
      deny: "Explicitly exclude",
      humanBoundary: "Agents cannot issue their own keys, add protected permissions, permanently delete resources, or transfer ownership. Those actions remain human-only.",
      unassignConfirm: "Remove this agent’s access to the workspace? Its identity and keys remain registered.",
      unassign: "Remove access",
      saving: "Saving…",
      savePermissions: "Save permissions",
    },
    ko: {
      keySuffix: "연결 키",
      existingKeyPlaceholder: "<기존 연결 키>",
      subtree: "{title} 이하",
      allDocuments: "모든 문서",
      connectFailed: "에이전트를 연결하지 못했습니다.",
      permissionSaveFailed: "워크스페이스 권한을 저장하지 못했습니다.",
      title: "에이전트 접근",
      description: "에이전트에게 이 워크스페이스 접근 권한을 부여하고, 필요한 경우 연결 키를 붙입니다.",
      connectAgent: "에이전트 연결",
      identityBoundaryTitle: "신원과 키는 계정에 한 번만 등록됩니다.",
      identityBoundary: "같은 에이전트를 여러 워크스페이스에서 재사용하되 접근 권한과 문서 범위는 각각 부여합니다. 키는 명시적으로 연결하며 자동으로 권한을 넓히지 않습니다.",
      emptyTitle: "아직 연결된 에이전트가 없습니다.",
      emptyHint: "기존 에이전트를 고르거나 새로 등록해 바로 연결할 수 있습니다.",
      firstConnection: "첫 에이전트 연결",
      membershipSummary: "{role} · {scope}",
      keyPermissionSummary: "연결 키 {keys}개 · 유효 권한 {permissions}개",
      permissionSettings: "권한 설정",
      ready: "연결이 준비됐습니다.",
      connectTitle: "{workspace}에 에이전트 연결",
      closeWizard: "에이전트 연결 닫기",
      progressLabel: "에이전트 연결 단계",
      stepAgent: "에이전트",
      stepAccess: "접근 권한과 범위",
      stepCredential: "연결 키",
      chooseAgent: "누구를 이 워크스페이스에 연결할까요?",
      chooseAgentHint: "이미 등록한 에이전트는 다시 만들 필요 없이 바로 선택할 수 있습니다.",
      identityMode: "에이전트 신원 선택 방식",
      existingAgent: "기존 에이전트",
      registerNewAgent: "새 에이전트 등록",
      agentMetrics: "활성 연결 키 {keys}개 · 다른 워크스페이스 {workspaces}곳",
      noExistingAgent: "연결할 수 있는 기존 에이전트가 없습니다. 새 에이전트를 등록해주세요.",
      agentName: "에이전트 이름",
      agentPlaceholder: "예: nyxdoc-builder",
      agentNameHint: "사람이 알아볼 수 있는 고유한 이름을 사용하세요. 나중에 변경할 수 있습니다.",
      chooseWork: "이 워크스페이스에서 허용할 작업을 정해주세요.",
      chooseWorkHint: "접근 프로필이 워크스페이스 권한이 되고, 문서 범위는 선택한 문서와 모든 하위 문서에 적용됩니다.",
      reader: "읽기",
      readerDescription: "문서 읽기·검색·변경 확인",
      drafter: "초안 작성",
      drafterDescription: "문서를 만들고 공유 초안을 편집하되 정본은 저장하지 않음",
      writer: "문서 작업",
      writerDescription: "문서를 만들고 편집하며 정본 리비전까지 저장",
      viewer: "뷰어",
      viewerDescription: "문서 읽기·검색·변경 확인",
      editor: "에디터",
      editorDescription: "문서 작성·수정·저장",
      admin: "워크스페이스 관리자",
      adminDescription: "문서 작업·담당·필터·감사·관리 요청",
      documentScope: "접근할 문서 범위",
      newAgentScope: "새 에이전트가 접근할 문서 범위",
      scopeHint: "기본값은 이 워크스페이스의 모든 문서입니다.",
      chooseKey: "외부 에이전트가 사용할 연결 키를 정해주세요.",
      chooseKeyHint: "이 단계는 키를 워크스페이스 접근 권한에 연결할 뿐입니다. 키의 스코프나 다른 연결 범위를 자동으로 넓히지 않습니다.",
      readWrite: "읽기·쓰기",
      readOnly: "읽기 전용",
      ipLimited: "IP 제한",
      expandScope: "선택 시 {workspace} 허용 범위 추가",
      inadequateRole: "역할 권한 부족",
      noCompatibleKey: "선택한 역할에 맞는 기존 키가 없어 새 키가 필요합니다.",
      createKey: "새 연결 키 만들기",
      keyShownOnce: "원문은 생성 직후 한 번만 표시됩니다.",
      keyName: "키 이름",
      existingKeyBoundary: "이 키의 현재 스코프는 그대로 유지됩니다. 워크스페이스 권한보다 좁으면 실제 권한도 그만큼 줄어듭니다.",
      bindLater: "연결 키는 나중에 붙이기",
      bindLaterHint: "워크스페이스 접근 권한만 먼저 저장합니다. 키나 OAuth 연결을 붙이기 전에는 이 워크스페이스에 접속할 수 없습니다.",
      accessSavedNoKey: "연결 키 없이 워크스페이스 접근 권한만 저장했습니다. 에이전트가 접속할 준비가 되면 에이전트 관리에서 키를 연결하세요.",
      restrictKey: "이 워크스페이스로 키 사용 범위 제한",
      restrictKeyHint: "끄면 이 에이전트가 앞으로 배정될 다른 워크스페이스에서도 같은 키를 쓸 수 있습니다.",
      expandExistingKey: "선택한 키의 기존 제한은 유지하고, {workspace}만 허용 범위에 추가합니다.",
      effectiveBoundary: "실제 권한은 활성 에이전트·키 스코프·워크스페이스 접근 권한·명시적 키 연결·문서 범위가 모두 허용하는 교집합입니다.",
      workspace: "워크스페이스",
      agent: "에이전트",
      role: "접근 프로필",
      scope: "문서 범위",
      handoffTitle: "이제 에이전트에게 전달하세요",
      handoffHint: "사용하는 에이전트의 대화창에 붙여넣으면 연결 정보와 확인 절차를 한 번에 전달합니다.",
      handoffCopied: "안내 전체가 복사됐습니다",
      copyHandoff: "에이전트 연결 안내 전체 복사",
      copyHandoffWithoutKey: "연결 안내 복사 · 기존 키 제외",
      secretWarning: "연결 키가 포함됩니다. 신뢰하는 에이전트의 비공개 대화에만 붙여넣으세요.",
      existingSecretWarning: "기존 키 원문은 안전상 다시 표시되지 않아 안내에 포함할 수 없습니다. 에이전트가 이미 저장한 {name}을 사용합니다.",
      keyOnce: "연결 키 · 지금 한 번만 표시",
      copied: "복사됨",
      copyKey: "키 복사",
      continueKey: "{name}을 계속 사용합니다.",
      existingKeyHint: "기존 키 원문은 다시 표시되지 않습니다. 에이전트에 저장된 값을 그대로 사용하세요.",
      manualSetup: "직접 설정하기 · MCP 주소와 앱별 예시",
      scopedUrl: "기본 워크스페이스가 포함된 MCP 주소",
      scopedUrlHint: "이 주소는 생략 시 쓸 기본값만 정합니다. 리소스 ID나 workspaceId로 허용된 다른 워크스페이스도 작업할 수 있습니다.",
      copyAddress: "주소 복사",
      codexConfig: "Codex 설정",
      openClawConfig: "OpenClaw 설정",
      copy: "복사",
      expandedAllowlist: "기존 키의 허용 범위에 {workspace}을 추가했습니다.",
      done: "완료",
      connectLater: "나중에 연결",
      cancel: "취소",
      previous: "이전",
      next: "다음",
      connecting: "연결 중…",
      membershipDescription: "워크스페이스 접근 권한과 연결 키의 제한은 서로 독립적입니다. 여기서 권한을 바꿔도 키의 범위는 넓어지지 않습니다.",
      roleBundle: "접근 프로필",
      agentScope: "에이전트가 접근할 문서 범위",
      fineTune: "기능 권한 사용자 지정",
      inherit: "역할 기본값",
      allow: "추가 허용",
      deny: "명시적 제외",
      humanBoundary: "에이전트 자신의 키 발급, 보호 권한 추가, 영구 삭제, 소유권 이전은 이 역할에 포함되지 않으며 사람만 처리합니다.",
      unassignConfirm: "이 워크스페이스에서 에이전트 접근 권한을 제거할까요? 에이전트 신원과 키는 그대로 유지됩니다.",
      unassign: "접근 제거",
      saving: "저장 중…",
      savePermissions: "권한 저장",
    },
    ja: {
      keySuffix: "接続キー",
      existingKeyPlaceholder: "<既存の接続キー>",
      subtree: "{title} 以下",
      allDocuments: "すべての文書",
      connectFailed: "エージェントを接続できませんでした。",
      permissionSaveFailed: "ワークスペース権限を保存できませんでした。",
      title: "エージェントアクセス",
      description: "エージェントにこのワークスペースへのアクセスを付与し、必要に応じて接続キーを関連付けます。",
      connectAgent: "エージェントを接続",
      identityBoundaryTitle: "IDとキーはアカウントへ一度だけ登録します。",
      identityBoundary: "同じエージェントを複数ワークスペースで再利用し、アクセス権と文書範囲は個別に付与します。キーは明示的に関連付け、自動拡張しません。",
      emptyTitle: "接続済みのエージェントはありません。",
      emptyHint: "既存のエージェントを選ぶか、新しく登録して接続できます。",
      firstConnection: "最初のエージェントを接続",
      membershipSummary: "{role} · {scope}",
      keyPermissionSummary: "接続キー{keys}件 · 実効権限{permissions}件",
      permissionSettings: "権限設定",
      ready: "接続の準備ができました。",
      connectTitle: "{workspace}にエージェントを接続",
      closeWizard: "エージェント接続を閉じる",
      progressLabel: "エージェント接続手順",
      stepAgent: "エージェント",
      stepAccess: "アクセスと範囲",
      stepCredential: "接続キー",
      chooseAgent: "このワークスペースへ誰を接続しますか？",
      chooseAgentHint: "登録済みエージェントは再登録せず、そのまま選択できます。",
      identityMode: "エージェントIDの選択方法",
      existingAgent: "既存のエージェント",
      registerNewAgent: "新しいエージェントを登録",
      agentMetrics: "有効な接続キー{keys}件 · 他のワークスペース{workspaces}か所",
      noExistingAgent: "接続できる既存エージェントがありません。新しいエージェントを登録してください。",
      agentName: "エージェント名",
      agentPlaceholder: "例：nyxdoc-builder",
      agentNameHint: "人が識別できる一意の名前を使用してください。後から変更できます。",
      chooseWork: "このワークスペースで許可する作業を選んでください。",
      chooseWorkHint: "アクセスプロファイルがワークスペース権限となり、文書範囲は選択した文書とすべての子文書へ適用されます。",
      reader: "閲覧",
      readerDescription: "文書の閲覧・検索・変更確認",
      drafter: "下書き作成",
      drafterDescription: "文書を作成し共有下書きを編集（正本は保存しない）",
      writer: "文書作業",
      writerDescription: "文書を作成・編集し、正本リビジョンを保存",
      viewer: "閲覧者",
      viewerDescription: "文書の閲覧・検索・変更確認",
      editor: "編集者",
      editorDescription: "文書の作成・編集・保存",
      admin: "ワークスペース管理者",
      adminDescription: "文書作業・担当・フィルター・監査・管理リクエスト",
      documentScope: "文書アクセス範囲",
      newAgentScope: "新しいエージェントの文書アクセス範囲",
      scopeHint: "既定値はこのワークスペースのすべての文書です。",
      chooseKey: "外部エージェントが使用する接続キーを選んでください。",
      chooseKeyHint: "この手順はキーをワークスペース権限へ関連付けるだけです。キーのスコープや他の関連付けを自動的に広げません。",
      readWrite: "読み取り・書き込み",
      readOnly: "読み取り専用",
      ipLimited: "IP制限",
      expandScope: "選択すると{workspace}を許可範囲へ追加",
      inadequateRole: "役割に必要な権限が不足",
      noCompatibleKey: "選択した役割に対応する既存キーがないため、新しいキーが必要です。",
      createKey: "新しい接続キーを作成",
      keyShownOnce: "原文は作成直後に一度だけ表示されます。",
      keyName: "キー名",
      existingKeyBoundary: "このキーの現在のスコープは維持されます。ワークスペース権限より狭い場合、実効権限もその分だけ制限されます。",
      bindLater: "接続キーは後で関連付ける",
      bindLaterHint: "ワークスペースアクセスだけを先に保存します。キーまたはOAuth資格情報を付けるまで接続はできません。",
      accessSavedNoKey: "接続キーなしでワークスペースアクセスを保存しました。準備ができたらエージェント管理からキーを関連付けてください。",
      restrictKey: "このワークスペースにキーの使用範囲を制限",
      restrictKeyHint: "オフにすると、このエージェントが今後割り当てられる他のワークスペースでも同じキーを使用できます。",
      expandExistingKey: "既存の制限を維持し、{workspace}だけを許可範囲へ追加します。",
      effectiveBoundary: "実効権限は、有効なエージェント、キースコープ、ワークスペース権限、明示的なキー関連付け、文書範囲の共通部分です。",
      workspace: "ワークスペース",
      agent: "エージェント",
      role: "アクセスプロファイル",
      scope: "文書範囲",
      handoffTitle: "エージェントへ渡してください",
      handoffHint: "エージェントの会話へ貼り付けると、接続情報と確認手順をまとめて渡せます。",
      handoffCopied: "ガイド全体をコピーしました",
      copyHandoff: "エージェント接続ガイドをコピー",
      copyHandoffWithoutKey: "接続ガイドをコピー · 既存キーを除外",
      secretWarning: "接続キーが含まれます。信頼できるエージェントの非公開会話にのみ貼り付けてください。",
      existingSecretWarning: "既存キーの原文は再表示できないためガイドに含まれません。エージェントが保存済みの{name}を使用します。",
      keyOnce: "接続キー · 今回だけ表示",
      copied: "コピーしました",
      copyKey: "キーをコピー",
      continueKey: "{name}を引き続き使用します。",
      existingKeyHint: "既存キーの原文は再表示されません。エージェントに保存済みの値を使用してください。",
      manualSetup: "手動設定 · MCP URLとアプリ別の例",
      scopedUrl: "既定ワークスペース付きMCP URL",
      scopedUrlHint: "このURLは省略時の既定値だけを設定します。リソースIDやworkspaceIdで許可済みの別ワークスペースも操作できます。",
      copyAddress: "URLをコピー",
      codexConfig: "Codex設定",
      openClawConfig: "OpenClaw設定",
      copy: "コピー",
      expandedAllowlist: "既存キーの許可範囲へ{workspace}を追加しました。",
      done: "完了",
      connectLater: "後で接続",
      cancel: "キャンセル",
      previous: "戻る",
      next: "次へ",
      connecting: "接続中…",
      membershipDescription: "ワークスペースアクセスと接続キーの制限は独立しています。ここで権限を変更してもキーの範囲は広がりません。",
      roleBundle: "アクセスプロファイル",
      agentScope: "エージェントの文書アクセス範囲",
      fineTune: "機能権限をカスタマイズ",
      inherit: "役割の既定値",
      allow: "追加で許可",
      deny: "明示的に除外",
      humanBoundary: "エージェント自身のキー発行、保護権限の追加、完全削除、所有権移転はこの役割に含まれず、人だけが実行できます。",
      unassignConfirm: "このワークスペースからエージェントの割り当てを解除しますか？キー自体は維持されます。",
      unassign: "割り当て解除",
      saving: "保存中…",
      savePermissions: "権限を保存",
    },
  }[locale];
}

export function WorkspaceAgentsPanel({
  accountAgents,
  documents,
  initiallyOpen = false,
  onboardingCompletionHref,
  initialMemberships,
  mcpUrl,
  workspace,
}: {
  accountAgents: AccountAgentSummary[];
  documents: DocumentSummary[];
  initiallyOpen?: boolean;
  onboardingCompletionHref?: string;
  initialMemberships: AgentWorkspaceMembershipSummary[];
  mcpUrl: string;
  workspace: WorkspaceSummary;
}) {
  const { locale } = useI18n();
  const copy = workspaceAgentCopy(locale);
  const router = useRouter();
  const initiallyAssignedIds = new Set(
    initialMemberships.filter((item) => item.status === "active").map((item) => item.agentId),
  );
  const initiallyAvailableAgent = accountAgents.find(
    (agent) => agent.status === "active"
      && !agent.deletedAt
      && !agent.purgedAt
      && !initiallyAssignedIds.has(agent.id),
  );
  const [agents, setAgents] = useState(accountAgents);
  const [memberships, setMemberships] = useState(initialMemberships);
  const [editing, setEditing] = useState<AgentWorkspaceMembershipSummary | null>(null);
  const [editProfile, setEditProfile] = useState<AgentAccessProfile>("reader");
  const [editCapabilities, setEditCapabilities] = useState<WorkspacePermission[]>(
    listAgentProfilePermissions("reader"),
  );
  const [editRoot, setEditRoot] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [wizardOpen, setWizardOpen] = useState(initiallyOpen);
  const [wizardStep, setWizardStep] = useState<ConnectionWizardStep>("identity");
  const [wizardIdentityMode, setWizardIdentityMode] = useState<"existing" | "new">(
    initiallyAvailableAgent ? "existing" : "new",
  );
  const [wizardAgentId, setWizardAgentId] = useState(initiallyAvailableAgent?.id ?? "");
  const [wizardNewAgentName, setWizardNewAgentName] = useState("");
  const [wizardProfile, setWizardProfile] = useState<AgentAccessProfile>("writer");
  const [wizardRoot, setWizardRoot] = useState("");
  const [wizardCredentialMode, setWizardCredentialMode] = useState<"existing" | "new" | "later">("new");
  const [wizardCredentialId, setWizardCredentialId] = useState("");
  const [wizardKeyName, setWizardKeyName] = useState(
    initiallyAvailableAgent ? `${initiallyAvailableAgent.displayName} ${copy.keySuffix}` : "",
  );
  const [wizardError, setWizardError] = useState("");
  const [wizardResult, setWizardResult] = useState<ConnectAgentToWorkspaceResult | null>(null);
  const [wizardCopied, setWizardCopied] = useState<string | null>(null);
  const activeMemberships = memberships.filter((item) => item.status === "active");
  const activeIds = new Set(activeMemberships.map((item) => item.agentId));
  const availableAgents = agents.filter(
    (agent) => agent.status === "active"
      && !agent.deletedAt
      && !agent.purgedAt
      && !activeIds.has(agent.id),
  );
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const wizardSelectedAgent = agentsById.get(wizardAgentId) ?? null;
  const wizardCredentials = (wizardSelectedAgent?.credentials ?? []).filter(activeCredential);
  const scopedMcpUrl = workspaceMcpUrl(mcpUrl, workspace.id);
  const wizardTokenValue = wizardResult?.token ?? copy.existingKeyPlaceholder;
  const codexSnippet = `[mcp_servers.nyxdoc]\nurl = "${scopedMcpUrl}"\nbearer_token_env_var = "NYXDOC_TOKEN"`;
  const openClawSnippet = JSON.stringify({
    url: scopedMcpUrl,
    transport: "streamable-http",
    headers: { Authorization: `Bearer ${wizardTokenValue}` },
  }, null, 2);
  const wizardHandoff = wizardResult?.credential ? buildAgentConnectionHandoff({
    agentName: wizardResult.agent.displayName,
    credentialName: wizardResult.credential.name,
    documentScope: wizardResult.membership.rootDocumentTitle
      ? formatCopy(copy.subtree, { title: wizardResult.membership.rootDocumentTitle })
      : copy.allDocuments,
    locale,
    mcpUrl: scopedMcpUrl,
    role: accessProfileLabel(wizardResult.membership.accessProfile, locale),
    token: wizardResult.token,
    workspaceName: workspace.name,
  }) : "";

  function workspaceRequest(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("x-nyxdoc-workspace-id", workspace.id);
    return fetch(path, { ...init, headers });
  }

  function clearAutomaticOpenFlag() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("connectAgent")) return;
    url.searchParams.delete("connectAgent");
    window.history.replaceState(window.history.state, "", url);
  }

  function resetWizard() {
    const nextAgent = availableAgents[0] ?? null;
    setWizardStep("identity");
    setWizardIdentityMode(nextAgent ? "existing" : "new");
    setWizardAgentId(nextAgent?.id ?? "");
    setWizardNewAgentName("");
    setWizardProfile("writer");
    setWizardRoot("");
    setWizardCredentialMode("new");
    setWizardCredentialId("");
    setWizardKeyName(nextAgent ? `${nextAgent.displayName} ${copy.keySuffix}` : "");
    setWizardError("");
    setWizardResult(null);
    setWizardCopied(null);
  }

  function openWizard() {
    resetWizard();
    setWizardOpen(true);
  }

  function closeWizard() {
    if (pending) return;
    if (onboardingCompletionHref) {
      window.location.assign(onboardingCompletionHref);
      return;
    }
    clearAutomaticOpenFlag();
    setWizardOpen(false);
    resetWizard();
  }

  function advanceToAccess() {
    if (wizardIdentityMode === "existing" && !wizardAgentId) return;
    if (wizardIdentityMode === "new" && !wizardNewAgentName.trim()) return;
    const name = wizardIdentityMode === "existing"
      ? wizardSelectedAgent?.displayName ?? ""
      : wizardNewAgentName.trim();
    setWizardKeyName(`${name} ${copy.keySuffix}`);
    setWizardError("");
    setWizardStep("access");
  }

  function advanceToCredential() {
    if (wizardIdentityMode === "existing" && wizardCredentials.length) {
      setWizardCredentialMode("existing");
      setWizardCredentialId(wizardCredentials[0].id);
    } else {
      setWizardCredentialMode("new");
      setWizardCredentialId("");
    }
    setWizardError("");
    setWizardStep("credential");
  }

  async function connectAgent() {
    if (pending) return;
    if (wizardCredentialMode === "existing" && !wizardCredentialId) return;
    if (wizardCredentialMode === "new" && !wizardKeyName.trim()) return;
    setPending(true);
    setWizardError("");
    try {
      const response = await workspaceRequest("/api/workspace-agents/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: wizardIdentityMode === "existing"
            ? { mode: "existing", agentId: wizardAgentId }
            : { mode: "new", displayName: wizardNewAgentName.trim() },
          accessProfile: wizardProfile,
          rootDocumentId: wizardRoot || null,
          credential: wizardCredentialMode === "existing"
            ? { mode: "existing", credentialId: wizardCredentialId }
            : wizardCredentialMode === "new" ? {
              mode: "new",
              name: wizardKeyName.trim(),
              restrictToWorkspace: true,
            } : { mode: "later" },
        }),
      });
      const body = await response.json() as ApiBody & Partial<ConnectAgentToWorkspaceResult>;
      if (!response.ok || !body.agent || !body.membership) {
        throw new Error(requestError(body, copy.connectFailed));
      }
      const result = body as ConnectAgentToWorkspaceResult;
      setAgents((current) => [result.agent, ...current.filter((item) => item.id !== result.agent.id)]);
      setMemberships((current) => [
        result.membership,
        ...current.filter((item) => item.agentId !== result.membership.agentId),
      ]);
      setWizardResult(result);
      setWizardStep("complete");
    } catch (cause) {
      setWizardError(cause instanceof Error ? cause.message : copy.connectFailed);
    } finally {
      setPending(false);
    }
  }

  async function copyWizardValue(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setWizardCopied(key);
    window.setTimeout(() => setWizardCopied((current) => current === key ? null : current), 1600);
  }

  function finishWizard() {
    if (onboardingCompletionHref) {
      window.location.assign(onboardingCompletionHref);
      return;
    }
    clearAutomaticOpenFlag();
    setWizardOpen(false);
    resetWizard();
    router.refresh();
  }

  function openEditor(membership: AgentWorkspaceMembershipSummary) {
    setEditing(membership);
    setEditProfile(membership.accessProfile);
    setEditCapabilities(membership.capabilities);
    setEditRoot(membership.rootDocumentId ?? "");
    setError("");
  }

  function selectAccessProfile(profile: AgentAccessProfile) {
    setEditProfile(profile);
    if (profile !== "custom") setEditCapabilities(listAgentProfilePermissions(profile));
  }

  function toggleCapability(permission: WorkspacePermission, checked: boolean) {
    const base = editProfile === "custom"
      ? editCapabilities
      : listAgentProfilePermissions(editProfile);
    setEditProfile("custom");
    setEditCapabilities(checked
      ? [...new Set([...base, permission])]
      : base.filter((item) => item !== permission));
  }

  async function saveMembership(status: "active" | "disabled" = "active") {
    if (!editing || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await workspaceRequest(`/api/workspace-agents/${editing.agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessProfile: editProfile,
          capabilities: editProfile === "custom" ? editCapabilities : undefined,
          rootDocumentId: editRoot || null,
          status,
        }),
      });
      const body = await response.json() as ApiBody & { membership?: AgentWorkspaceMembershipSummary };
      if (!response.ok || !body.membership) throw new Error(requestError(body, copy.permissionSaveFailed));
      setMemberships((current) => current.map((item) => item.membershipId === body.membership!.membershipId ? body.membership! : item));
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.permissionSaveFailed);
    } finally {
      setPending(false);
    }
  }

  return <>
    <section className={styles.settingsCard} id="workspace-agents">
      <div className={styles.workspaceAgentSectionHeader}>
        <div className={styles.sectionHeading}><span className={styles.connectionIcon}><ShieldCheck size={18} /></span><div><h2>{copy.title}</h2><p>{copy.description}</p></div></div>
        <button type="button" onClick={openWizard}><Plus size={15} /> {copy.connectAgent}</button>
      </div>
      <div className={styles.workspaceAdminRoleNote}><ShieldCheck size={15} /><span><strong>{copy.identityBoundaryTitle}</strong> {copy.identityBoundary}</span></div>
      <div className={styles.workspaceAgentList}>
        {activeMemberships.length === 0 ? <div className={styles.workspaceAgentEmpty}><UserRound size={20} /><div><strong>{copy.emptyTitle}</strong><small>{copy.emptyHint}</small></div><button type="button" onClick={openWizard}>{copy.firstConnection}</button></div> : activeMemberships.map((membership) => {
          const agent = agentsById.get(membership.agentId);
          if (!agent) return null;
          const scope = membership.rootDocumentTitle
            ? formatCopy(copy.subtree, { title: membership.rootDocumentTitle })
            : copy.allDocuments;
          return <article className={styles.workspaceAgentCard} key={membership.membershipId}>
            <UserAvatar className={styles.agentAvatar} imageUrl={agent.avatarMediaId ? `/api/media/${agent.avatarMediaId}` : null} name={agent.displayName} />
            <div><strong>{agent.displayName}</strong><small>{formatCopy(copy.membershipSummary, {
              role: accessProfileLabel(membership.accessProfile, locale),
              scope,
            })}</small><small>{formatCopy(copy.keyPermissionSummary, {
              keys: agent.credentials.filter(activeCredential).length,
              permissions: membership.effectivePermissions.length,
            })}</small></div>
            <button type="button" className={styles.connectionPermissionsButton} onClick={() => openEditor(membership)}><Settings2 size={14} /> {copy.permissionSettings}</button>
          </article>;
        })}
      </div>
      {error && <div className={styles.inlineError} role="alert">{error}</div>}
    </section>

    {wizardOpen && <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.connectionWizardModal} role="dialog" aria-modal="true" aria-labelledby="connection-wizard-title">
        <header className={styles.connectionWizardHeader}>
          <div className={styles.connectionEditIcon}>{wizardStep === "complete" ? <Check size={20} /> : <KeyRound size={20} />}</div>
          <div><p>WORKSPACE AGENT CONNECTION</p><h2 id="connection-wizard-title">{wizardStep === "complete" ? copy.ready : formatCopy(copy.connectTitle, { workspace: workspace.name })}</h2></div>
          {wizardStep !== "complete" && <button type="button" aria-label={copy.closeWizard} onClick={closeWizard} disabled={pending}><X size={18} /></button>}
        </header>

        <ol className={styles.connectionWizardProgress} aria-label={copy.progressLabel}>
          {[
            ["identity", "1", copy.stepAgent],
            ["access", "2", copy.stepAccess],
            ["credential", "3", copy.stepCredential],
          ].map(([step, number, label]) => {
            const order = ["identity", "access", "credential", "complete"];
            const state = wizardStep === "complete" || order.indexOf(wizardStep) > order.indexOf(step)
              ? "done"
              : wizardStep === step ? "active" : "upcoming";
            return <li data-state={state} key={step}><span>{state === "done" ? <Check size={13} /> : number}</span><strong>{label}</strong></li>;
          })}
        </ol>

        {wizardStep === "identity" && <div className={styles.connectionWizardBody}>
          <div className={styles.connectionWizardIntro}><strong>{copy.chooseAgent}</strong><small>{copy.chooseAgentHint}</small></div>
          <div className={styles.connectionWizardTabs} role="tablist" aria-label={copy.identityMode}>
            <button type="button" role="tab" aria-selected={wizardIdentityMode === "existing"} onClick={() => setWizardIdentityMode("existing")}>{copy.existingAgent}</button>
            <button type="button" role="tab" aria-selected={wizardIdentityMode === "new"} onClick={() => setWizardIdentityMode("new")}>{copy.registerNewAgent}</button>
          </div>
          {wizardIdentityMode === "existing" ? <div className={styles.connectionWizardAgentList}>
            {availableAgents.length ? availableAgents.map((agent) => <label data-selected={wizardAgentId === agent.id} key={agent.id}>
              <input type="radio" name="wizard-agent" value={agent.id} checked={wizardAgentId === agent.id} onChange={() => { setWizardAgentId(agent.id); setWizardKeyName(`${agent.displayName} ${copy.keySuffix}`); }} />
              <UserAvatar className={styles.agentAvatar} imageUrl={agent.avatarMediaId ? `/api/media/${agent.avatarMediaId}` : null} name={agent.displayName} />
              <span><strong>{agent.displayName}</strong><small>{formatCopy(copy.agentMetrics, {
                keys: agent.credentials.filter(activeCredential).length,
                workspaces: agent.memberships.filter((membership) => membership.status === "active").length,
              })}</small></span>
              {wizardAgentId === agent.id && <Check size={17} />}
            </label>) : <div className={styles.connectionWizardEmpty}>{copy.noExistingAgent}</div>}
          </div> : <label className={styles.connectionWizardField}><span>{copy.agentName}</span><input autoFocus value={wizardNewAgentName} onChange={(event) => setWizardNewAgentName(event.target.value)} placeholder={copy.agentPlaceholder} maxLength={80} /><small>{copy.agentNameHint}</small></label>}
        </div>}

        {wizardStep === "access" && <div className={styles.connectionWizardBody}>
          <div className={styles.connectionWizardIntro}><strong>{copy.chooseWork}</strong><small>{copy.chooseWorkHint}</small></div>
          <div className={styles.connectionRoleGrid}>
            {([
              ["reader", copy.reader, copy.readerDescription],
              ["drafter", copy.drafter, copy.drafterDescription],
              ["writer", copy.writer, copy.writerDescription],
            ] as const).map(([profile, label, description]) => <label data-selected={wizardProfile === profile} key={profile}>
              <input type="radio" name="wizard-profile" value={profile} checked={wizardProfile === profile} onChange={() => setWizardProfile(profile)} />
              <span><strong>{label}</strong><small>{description}</small></span>
              {wizardProfile === profile && <Check size={16} />}
            </label>)}
          </div>
          <div className={styles.connectionWizardScope}><span>{copy.documentScope}</span><DocumentScopePicker ariaLabel={copy.newAgentScope} documents={documents} value={wizardRoot} onChange={setWizardRoot} workspaceName={workspace.name} /><small>{copy.scopeHint}</small></div>
        </div>}

        {wizardStep === "credential" && <div className={styles.connectionWizardBody}>
          <div className={styles.connectionWizardIntro}><strong>{copy.chooseKey}</strong><small>{copy.chooseKeyHint}</small></div>
          {wizardIdentityMode === "existing" && wizardCredentials.length > 0 && <div className={styles.connectionCredentialList}>
            {wizardCredentials.map((credential) => {
              return <label data-selected={wizardCredentialMode === "existing" && wizardCredentialId === credential.id} key={credential.id}>
                <input type="radio" name="wizard-credential" checked={wizardCredentialMode === "existing" && wizardCredentialId === credential.id} onChange={() => { setWizardCredentialMode("existing"); setWizardCredentialId(credential.id); }} />
                <KeyRound size={17} />
                <span><strong>{credential.name}</strong><small>{credential.prefix}… · {credential.scopes.includes("documents:write") ? copy.readWrite : copy.readOnly}{credential.ipAllowlist.length ? ` · ${copy.ipLimited}` : ""}</small></span>
                {wizardCredentialMode === "existing" && wizardCredentialId === credential.id ? <Check size={16} /> : null}
              </label>;
            })}
          </div>}
          {wizardCredentialMode === "existing" && <div className={styles.connectionWizardNotice}>{copy.existingKeyBoundary}</div>}
          <label className={styles.connectionNewCredential} data-selected={wizardCredentialMode === "new"}>
            <input type="radio" name="wizard-credential" checked={wizardCredentialMode === "new"} onChange={() => setWizardCredentialMode("new")} />
            <Plus size={17} />
            <span><strong>{copy.createKey}</strong><small>{copy.keyShownOnce}</small></span>
            {wizardCredentialMode === "new" && <Check size={16} />}
          </label>
          {wizardCredentialMode === "new" && <div className={styles.connectionNewCredentialFields}>
            <label><span>{copy.keyName}</span><input value={wizardKeyName} onChange={(event) => setWizardKeyName(event.target.value)} maxLength={80} /></label>
          </div>}
          <label className={styles.connectionNewCredential} data-selected={wizardCredentialMode === "later"}>
            <input type="radio" name="wizard-credential" checked={wizardCredentialMode === "later"} onChange={() => setWizardCredentialMode("later")} />
            <KeyRound size={17} />
            <span><strong>{copy.bindLater}</strong><small>{copy.bindLaterHint}</small></span>
            {wizardCredentialMode === "later" && <Check size={16} />}
          </label>
          <div className={styles.connectionSecurityNote}><ShieldCheck size={16} /><span>{copy.effectiveBoundary}</span></div>
        </div>}

        {wizardStep === "complete" && wizardResult && <div className={styles.connectionWizardBody}>
          <div className={styles.connectionCompleteSummary}>
            <div><span>{copy.workspace}</span><strong>{workspace.name}</strong></div>
            <div><span>{copy.agent}</span><strong>{wizardResult.agent.displayName}</strong></div>
            <div><span>{copy.role}</span><strong>{accessProfileLabel(wizardResult.membership.accessProfile, locale)}</strong></div>
            <div><span>{copy.scope}</span><strong>{wizardResult.membership.rootDocumentTitle ? formatCopy(copy.subtree, { title: wizardResult.membership.rootDocumentTitle }) : copy.allDocuments}</strong></div>
          </div>
          {wizardResult.credential ? <><div className={styles.agentHandoffCard}>
            <div className={styles.agentHandoffHeading}><span><Bot size={18} /></span><div><strong>{copy.handoffTitle}</strong><small>{copy.handoffHint}</small></div></div>
            <button type="button" onClick={() => void copyWizardValue(wizardHandoff, "handoff")}><Copy size={15} /> {wizardCopied === "handoff" ? copy.handoffCopied : wizardResult.token ? copy.copyHandoff : copy.copyHandoffWithoutKey}</button>
            {wizardResult.token
              ? <em>{copy.secretWarning}</em>
              : <em>{formatCopy(copy.existingSecretWarning, { name: wizardResult.credential.name })}</em>}
          </div>
          {wizardResult.token ? <div className={styles.connectionSecretSection}><strong>{copy.keyOnce}</strong><div className={styles.secretBox}><code>{wizardResult.token}</code><button type="button" onClick={() => void copyWizardValue(wizardResult.token!, "token")}><Copy size={14} /> {wizardCopied === "token" ? copy.copied : copy.copyKey}</button></div></div> : <div className={styles.connectionExistingKeyNotice}><KeyRound size={17} /><span><strong>{formatCopy(copy.continueKey, { name: wizardResult.credential.name })}</strong><small>{copy.existingKeyHint}</small></span></div>}
          <details className={styles.connectionAdvancedDetails}>
            <summary>{copy.manualSetup}</summary>
            <div className={styles.connectionConfigSection}>
              <div><strong>{copy.scopedUrl}</strong><small>{copy.scopedUrlHint}</small></div>
              <div className={styles.configBox}><pre>{scopedMcpUrl}</pre><button type="button" onClick={() => void copyWizardValue(scopedMcpUrl, "url")}><Copy size={14} /> {wizardCopied === "url" ? copy.copied : copy.copyAddress}</button></div>
              <div className={styles.connectionConfigLabel}><strong>{copy.codexConfig}</strong><button type="button" onClick={() => void copyWizardValue(codexSnippet, "codex")}><Copy size={13} /> {wizardCopied === "codex" ? copy.copied : copy.copy}</button></div>
              <pre className={styles.connectionCodeBlock}>{codexSnippet}</pre>
              <div className={styles.connectionConfigLabel}><strong>{copy.openClawConfig}</strong><button type="button" onClick={() => void copyWizardValue(openClawSnippet, "openclaw")}><Copy size={13} /> {wizardCopied === "openclaw" ? copy.copied : copy.copy}</button></div>
              <pre className={styles.connectionCodeBlock}>{openClawSnippet}</pre>
            </div>
          </details></> : <div className={styles.connectionWizardNotice}>{copy.accessSavedNoKey}</div>}
          <button className={styles.doneButton} type="button" onClick={finishWizard}>{copy.done}</button>
        </div>}

        {wizardError && <div className={styles.connectionWizardError} role="alert">{wizardError}</div>}
        {wizardStep !== "complete" && <footer className={styles.connectionWizardFooter}>
          {wizardStep === "identity" ? <button type="button" onClick={closeWizard} disabled={pending}>{onboardingCompletionHref ? copy.connectLater : copy.cancel}</button> : <button type="button" onClick={() => { setWizardError(""); setWizardStep(wizardStep === "credential" ? "access" : "identity"); }} disabled={pending}>{copy.previous}</button>}
          {wizardStep === "identity" && <button type="button" onClick={advanceToAccess} disabled={pending || (wizardIdentityMode === "existing" ? !wizardAgentId : !wizardNewAgentName.trim())}>{copy.next} <ArrowRight size={14} /></button>}
          {wizardStep === "access" && <button type="button" onClick={advanceToCredential} disabled={pending}>{copy.next} <ArrowRight size={14} /></button>}
          {wizardStep === "credential" && <button type="button" onClick={() => void connectAgent()} disabled={pending || (wizardCredentialMode === "existing" ? !wizardCredentialId : wizardCredentialMode === "new" ? !wizardKeyName.trim() : false)}>{pending ? copy.connecting : copy.connectAgent} <ArrowRight size={14} /></button>}
        </footer>}
      </section>
    </div>}

    {editing && <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.membershipModal} role="dialog" aria-modal="true" aria-labelledby="membership-editor-title">
        <div className={styles.connectionEditIcon}><ShieldCheck size={20} /></div><p>WORKSPACE PERMISSIONS</p><h2 id="membership-editor-title">{agentsById.get(editing.agentId)?.displayName} · {workspace.name}</h2><span>{copy.membershipDescription}</span>
        <div className={styles.connectionEditFields}>
          <label><span>{copy.roleBundle}</span><select value={editProfile} onChange={(event) => selectAccessProfile(event.target.value as AgentAccessProfile)}>{AGENT_ACCESS_PROFILES.map((profile) => <option value={profile} key={profile}>{accessProfileLabel(profile, locale)}</option>)}</select></label>
          <div className={styles.connectionEditField}><span>{copy.documentScope}</span><DocumentScopePicker ariaLabel={copy.agentScope} documents={documents} value={editRoot} onChange={setEditRoot} workspaceName={workspace.name} /></div>
        </div>
        <details className={styles.permissionDetails}><summary>{copy.fineTune}</summary><div className={styles.permissionMatrix}>{delegablePermissions(locale).map((permission) => {
          const checked = editCapabilities.includes(permission.value);
          return <label key={permission.value}><span><strong>{permission.label}</strong><small>{permission.description}</small></span><input type="checkbox" checked={checked} onChange={(event) => toggleCapability(permission.value, event.target.checked)} /> </label>;
        })}</div><small>{copy.humanBoundary}</small></details>
        {error && <div className={styles.inlineError} role="alert">{error}</div>}
        <footer><button type="button" className={styles.dangerButton} onClick={() => { if (window.confirm(copy.unassignConfirm)) void saveMembership("disabled"); }} disabled={pending}><Trash2 size={14} /> {copy.unassign}</button><span /><button type="button" onClick={() => { setEditing(null); setError(""); }} disabled={pending}>{copy.cancel}</button><button type="button" onClick={() => void saveMembership()} disabled={pending}><Save size={14} /> {pending ? copy.saving : copy.savePermissions}</button></footer>
      </section>
    </div>}
  </>;
}
