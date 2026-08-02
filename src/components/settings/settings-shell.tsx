"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Building2,
  Check,
  Copy,
  Globe2,
  ImagePlus,
  LockKeyhole,
  LogOut,
  MailCheck,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { NyxdocMark } from "@/components/brand/nyxdoc-mark";
import { UserAvatar } from "@/components/profile/user-avatar";
import { AccountAgentsPanel, WorkspaceAgentsPanel } from "@/components/settings/agent-management";
import { SiteAdministrationPanel } from "@/components/settings/site-administration";
import {
  OrganizationCreateDialog,
  OrganizationDirectory,
  OrganizationSettingsPanel,
} from "@/components/organizations/organization-settings-panel";
import {
  CREATE_WORKSPACE_OPTION_VALUE,
  WorkspaceCreateDialog,
} from "@/components/workspace/workspace-create-dialog";
import { authClient } from "@/lib/auth-client";
import { uploadMediaFile } from "@/lib/media/client";
import type { SettingsView } from "@/lib/settings/types";
import type { AdminActionRequest } from "@/lib/admin-requests/types";
import { rememberWorkspaceSelection } from "@/lib/workspaces/selection";
import {
  localeLabel,
  localeTag,
  SUPPORTED_LOCALES,
  type AppLocale,
} from "@/lib/i18n/locales";
import { useI18n } from "@/lib/i18n/client";
import { defineUiCopy, formatCopy } from "@/lib/i18n/copy";
import styles from "./settings.module.css";

type ProfileApiBody = {
  error?: string;
  profile?: {
    image: string | null;
    locale: AppLocale | null;
    name: string;
  };
};

type WorkspaceApiBody = {
  error?: string;
  workspace?: { id: string; name: string };
};

type WorkspaceLifecycleApiBody = {
  error?: string;
  nextWorkspaceId?: string;
  workspace?: {
    id: string;
    name: string;
    lifecycleState: "active" | "trashed" | "purged";
  };
};

type AdminReviewApiBody = {
  error?: string;
  request?: AdminActionRequest;
  revealedToken?: string;
};

type ConnectionGuide = "openclaw" | "codex" | "direct";
type CopyTarget = "token" | "endpoint" | ConnectionGuide;

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const SETTINGS_COPY = defineUiCopy({
  en: {
    connectionKey: "<connection key>",
    openClawConfig: "OpenClaw configuration",
    codexConfig: "Codex configuration",
    connectionInfo: "Connection information",
    copyValue: "Copy {name}",
    avatarFormats: "PNG, JPEG, GIF, WebP · up to 5 MB",
    invalidAvatar: "Use a PNG, JPEG, GIF, or WebP image.",
    avatarTooLarge: "Choose an avatar image no larger than 5 MB.",
    profileSaveFailed: "Could not save the profile.",
    workspaceSaveFailed: "Could not save the workspace name.",
    workspaceTrashFailed: "Could not move the workspace to trash.",
    adminRequestFailed: "Could not process the administration request.",
    backToDocuments: "Back to documents",
    wholeSite: "Entire site",
    siteOwner: "Site owner",
    siteAdministrator: "Site administrator",
    wholeSiteHint: "Applies to every user and workspace.",
    activeWorkspace: "Active workspace",
    newWorkspace: "＋ New workspace",
    owner: "Owner",
    member: "Member",
    admin: "Administrator",
    editor: "Editor",
    viewer: "Viewer",
    boundaryHint: "Documents and agents are managed within this boundary.",
    settingsMenu: "Settings menu",
    myAccount: "My account",
    accountSettings: "Account settings",
    agents: "Agents",
    agentManagement: "Agent management",
    agentIdentity: "Agent identities",
    connectionKeys: "Connection keys",
    deletedAgents: "Deleted agents",
    organizations: "Organizations",
    organizationSettings: "Organization settings",
    organizationDescription: "Manage shared people, teams, workspaces, agents, and access boundaries.",
    newOrganization: "＋ New organization",
    chooseOrganization: "Active organization",
    noOrganization: "Create an organization when you need a shared namespace. Personal workspaces remain unchanged.",
    createOrganization: "Create organization",
    organizationGeneral: "General",
    organizationMembers: "People and invitations",
    organizationTeams: "Teams",
    organizationWorkspaces: "Workspace access",
    organizationAgents: "Organization agents",
    organizationAudit: "Audit",
    organizationDelete: "Delete organization",
    workspace: "Workspace",
    workspaceSettings: "Workspace settings",
    general: "General",
    agentPermissions: "Agent assignments and permissions",
    operations: "Operations and audit",
    workspaceDelete: "Delete workspace",
    site: "Site",
    siteAdministration: "Site administration",
    accountDescription: "Manage your profile and account security.",
    agentsDescription: "Manage agent identities and connection keys in one place.",
    siteDescription: "Manage registration, mail, the public URL, and operational status for this Nyxdoc instance.",
    workspaceDescription: "Assign agents to {workspace} and manage their roles and document scope.",
    myInformation: "My information",
    profileDescription: "Account information shown in document revision history.",
    profilePhoto: "Profile photo",
    chooseImage: "Choose image",
    delete: "Delete",
    displayName: "Display name",
    email: "Email",
    saved: "Saved.",
    saving: "Saving…",
    saveChanges: "Save changes",
    workspaceInformation: "Workspace information",
    workspaceBoundary: "A top-level work area that isolates documents, memberships, permissions, and audit records from other workspaces.",
    currentWorkspace: "Workspace being configured",
    workspaceName: "Workspace name",
    saveName: "Save name",
    operationsDescription: "Administrative agents submit requests instead of changing permissions directly, and the human review is recorded.",
    adminRequests: "Administration requests",
    approvalBoundary: "Workspaces, agents, and connection keys remain unchanged until approval.",
    pendingCount: "{count} pending",
    noAdminRequests: "No administration requests have been submitted by agents.",
    requestReason: "Reason",
    reviewedBy: "reviewed by {name}",
    reject: "Reject",
    processing: "Processing…",
    approveExecute: "Approve and execute",
    recentAudit: "Recent audit records",
    auditDescription: "Immutable records of permission, key, trash, assignment, and other operational changes.",
    noAudit: "No operational changes have been recorded.",
    workspaceDeleteDescription: "Move only the active workspace to trash. Restore and permanent deletion are managed from the unified trash.",
    workspaceAccessBlocked: "Access for people and agents is blocked immediately, while documents, revisions, media, memberships, and agent assignments are preserved.",
    ownerOnlyDelete: "Only the workspace owner can delete this workspace.",
    lastWorkspace: "The last workspace cannot be deleted. Create another workspace first.",
    moveToTrash: "Move to trash",
    security: "Security",
    securityDescription: "Manage sign-in and account access.",
    emailVerified: "Email verified",
    resetPassword: "Reset password",
    signOut: "Sign out",
    confirmWorkspaceTrash: "Move this workspace to trash?",
    workspaceTrashExplanation: "Access is blocked immediately, but all data is preserved. You can later restore or permanently delete it from the unified trash in the document view.",
    typeWorkspaceName: "Enter the workspace name to confirm.",
    moving: "Moving…",
    cancel: "Cancel",
    approveQuestion: "Approve this administration request?",
    rejectQuestion: "Reject this administration request?",
    reviewNote: "Review note (optional)",
    reviewNotePlaceholder: "Record the reason for the decision or what you verified.",
    rejectRequest: "Reject request",
    tokenReady: "The agent connection key is ready.",
    tokenOnce: "This key is shown only once. Store it somewhere safe.",
    copied: "Copied",
    copyKey: "Copy key",
    whichAgent: "Which agent would you like to connect?",
    guideFormats: "The format differs by client, but the MCP URL and connection key are the same.",
    guideAria: "Connection guide by agent",
    direct: "Direct connection",
    openClawGuide: "Create an MCP configuration named nyxdoc in OpenClaw and register the JSON above. Then verify it with openclaw mcp doctor nyxdoc --probe. Do not share a configuration that contains the key.",
    officialGuide: "Official guide",
    codexGuide: "Store the connection key above in the NYXDOC_TOKEN environment variable, then start Codex.",
    directGuide: "The same values work with any agent that supports Streamable HTTP MCP and a Bearer header.",
    stored: "I stored it",
    statusPending: "Pending approval",
    statusExecuted: "Executed",
    statusRejected: "Rejected",
    statusFailed: "Execution failed",
    statusExpired: "Expired",
  },
  ko: {
    connectionKey: "<연결 키>",
    openClawConfig: "OpenClaw 설정",
    codexConfig: "Codex 설정",
    connectionInfo: "연결 정보",
    copyValue: "{name} 복사",
    avatarFormats: "PNG, JPEG, GIF, WebP · 최대 5MB",
    invalidAvatar: "PNG, JPEG, GIF, WebP 이미지만 사용할 수 있습니다.",
    avatarTooLarge: "아바타 이미지는 5MB 이하로 선택해주세요.",
    profileSaveFailed: "프로필을 저장하지 못했습니다.",
    workspaceSaveFailed: "워크스페이스 이름을 저장하지 못했습니다.",
    workspaceTrashFailed: "워크스페이스를 휴지통으로 옮기지 못했습니다.",
    adminRequestFailed: "관리 요청을 처리하지 못했습니다.",
    backToDocuments: "문서로 돌아가기",
    wholeSite: "사이트 전체",
    siteOwner: "사이트 소유자",
    siteAdministrator: "사이트 관리자",
    wholeSiteHint: "모든 사용자와 워크스페이스에 적용됩니다.",
    activeWorkspace: "작업 중인 워크스페이스",
    newWorkspace: "＋ 새 워크스페이스",
    owner: "소유자",
    member: "멤버",
    admin: "관리자",
    editor: "편집자",
    viewer: "뷰어",
    boundaryHint: "문서와 에이전트가 이 경계 안에서 관리됩니다.",
    settingsMenu: "설정 메뉴",
    myAccount: "내 계정",
    accountSettings: "계정 설정",
    agents: "에이전트",
    agentManagement: "에이전트 관리",
    agentIdentity: "에이전트 신원",
    connectionKeys: "연결 키",
    deletedAgents: "삭제된 에이전트",
    organizations: "조직",
    organizationSettings: "조직 설정",
    organizationDescription: "공유할 사람·팀·워크스페이스·에이전트와 접근 경계를 관리합니다.",
    newOrganization: "＋ 새 조직",
    chooseOrganization: "현재 조직",
    noOrganization: "공유 네임스페이스가 필요할 때 조직을 만드세요. 개인 워크스페이스는 그대로 유지됩니다.",
    createOrganization: "조직 만들기",
    organizationGeneral: "일반",
    organizationMembers: "사람과 초대",
    organizationTeams: "팀",
    organizationWorkspaces: "워크스페이스 접근",
    organizationAgents: "조직 에이전트",
    organizationAudit: "감사 기록",
    organizationDelete: "조직 삭제",
    workspace: "워크스페이스",
    workspaceSettings: "워크스페이스 설정",
    general: "일반",
    agentPermissions: "에이전트 배정·권한",
    operations: "운영과 감사",
    workspaceDelete: "워크스페이스 삭제",
    site: "사이트",
    siteAdministration: "사이트 관리",
    accountDescription: "내 프로필과 계정 보안을 관리합니다.",
    agentsDescription: "에이전트 신원과 연결 키를 한 곳에서 관리합니다.",
    siteDescription: "가입, 메일, 공개 주소와 운영 상태를 인스턴스 전체 범위에서 관리합니다.",
    workspaceDescription: "{workspace}에 에이전트를 할당하고 역할과 문서 범위를 관리합니다.",
    myInformation: "내 정보",
    profileDescription: "문서 변경 기록에 표시되는 계정 정보입니다.",
    profilePhoto: "프로필 사진",
    chooseImage: "이미지 선택",
    delete: "삭제",
    displayName: "표시 이름",
    email: "이메일",
    saved: "저장되었습니다.",
    saving: "저장 중…",
    saveChanges: "변경사항 저장",
    workspaceInformation: "워크스페이스 정보",
    workspaceBoundary: "문서·멤버십·권한·감사 기록이 다른 워크스페이스와 분리되는 최상위 작업 공간입니다.",
    currentWorkspace: "현재 설정 중인 워크스페이스",
    workspaceName: "워크스페이스 이름",
    saveName: "이름 저장",
    operationsDescription: "관리 에이전트는 직접 권한을 바꾸지 않고 요청하며, 사람이 검토한 결과가 기록됩니다.",
    adminRequests: "관리 요청",
    approvalBoundary: "승인 전에는 워크스페이스·에이전트·연결 키가 바뀌지 않습니다.",
    pendingCount: "{count} 대기",
    noAdminRequests: "에이전트가 요청한 관리 작업이 없습니다.",
    requestReason: "요청 이유",
    reviewedBy: "{name} 검토",
    reject: "거절",
    processing: "처리 중…",
    approveExecute: "승인하고 실행",
    recentAudit: "최근 감사 기록",
    auditDescription: "권한·키·휴지통·담당 지정 등 운영 변경의 불변 기록입니다.",
    noAudit: "아직 기록된 운영 변경이 없습니다.",
    workspaceDeleteDescription: "현재 작업 중인 워크스페이스만 휴지통으로 옮깁니다. 복구와 영구 삭제는 통합 휴지통에서 관리합니다.",
    workspaceAccessBlocked: "사람과 에이전트의 접근은 즉시 차단되지만 문서·리비전·미디어·멤버십과 에이전트 배정은 보존됩니다.",
    ownerOnlyDelete: "워크스페이스 소유자만 삭제할 수 있습니다.",
    lastWorkspace: "마지막 워크스페이스는 삭제할 수 없습니다. 먼저 새 워크스페이스를 만들어주세요.",
    moveToTrash: "휴지통으로 이동",
    security: "보안",
    securityDescription: "로그인과 계정 접근을 관리합니다.",
    emailVerified: "이메일 인증 완료",
    resetPassword: "비밀번호 재설정",
    signOut: "로그아웃",
    confirmWorkspaceTrash: "워크스페이스를 휴지통으로 옮길까요?",
    workspaceTrashExplanation: "접근은 즉시 차단되지만 모든 데이터는 보존됩니다. 이후 문서 화면의 통합 휴지통에서 복구하거나 영구 삭제할 수 있습니다.",
    typeWorkspaceName: "확인을 위해 워크스페이스 이름을 입력하세요.",
    moving: "이동 중…",
    cancel: "취소",
    approveQuestion: "이 관리 요청을 승인할까요?",
    rejectQuestion: "이 관리 요청을 거절할까요?",
    reviewNote: "검토 메모 (선택)",
    reviewNotePlaceholder: "결정 이유나 확인한 내용을 남겨두세요.",
    rejectRequest: "요청 거절",
    tokenReady: "에이전트 연결 키가 준비됐어요.",
    tokenOnce: "이 키는 지금 한 번만 표시됩니다. 안전한 곳에 저장하세요.",
    copied: "복사됨",
    copyKey: "키 복사",
    whichAgent: "어떤 에이전트에 연결할까요?",
    guideFormats: "설정 형식만 다르고 같은 MCP 주소와 연결 키를 사용합니다.",
    guideAria: "에이전트별 연결 안내",
    direct: "직접 연결",
    openClawGuide: "OpenClaw의 MCP 설정에서 이름을 nyxdoc으로 만들고 위 JSON을 등록하세요. 이후 openclaw mcp doctor nyxdoc --probe로 확인할 수 있습니다. 키가 든 설정은 공유하지 마세요.",
    officialGuide: "공식 안내",
    codexGuide: "NYXDOC_TOKEN 환경 변수에 위 연결 키를 저장한 뒤 Codex를 시작하세요.",
    directGuide: "Streamable HTTP MCP와 Bearer 헤더를 지원하는 다른 에이전트에도 같은 값으로 연결할 수 있습니다.",
    stored: "저장했어요",
    statusPending: "승인 대기",
    statusExecuted: "실행 완료",
    statusRejected: "거절됨",
    statusFailed: "실행 실패",
    statusExpired: "만료됨",
  },
  ja: {
    connectionKey: "<接続キー>",
    openClawConfig: "OpenClaw設定",
    codexConfig: "Codex設定",
    connectionInfo: "接続情報",
    copyValue: "{name}をコピー",
    avatarFormats: "PNG、JPEG、GIF、WebP · 最大5MB",
    invalidAvatar: "PNG、JPEG、GIF、WebP画像のみ使用できます。",
    avatarTooLarge: "アバター画像は5MB以下にしてください。",
    profileSaveFailed: "プロフィールを保存できませんでした。",
    workspaceSaveFailed: "ワークスペース名を保存できませんでした。",
    workspaceTrashFailed: "ワークスペースをゴミ箱へ移動できませんでした。",
    adminRequestFailed: "管理リクエストを処理できませんでした。",
    backToDocuments: "文書に戻る",
    wholeSite: "サイト全体",
    siteOwner: "サイト所有者",
    siteAdministrator: "サイト管理者",
    wholeSiteHint: "すべてのユーザーとワークスペースに適用されます。",
    activeWorkspace: "作業中のワークスペース",
    newWorkspace: "＋ 新しいワークスペース",
    owner: "所有者",
    member: "メンバー",
    admin: "管理者",
    editor: "編集者",
    viewer: "閲覧者",
    boundaryHint: "文書とエージェントはこの境界内で管理されます。",
    settingsMenu: "設定メニュー",
    myAccount: "自分のアカウント",
    accountSettings: "アカウント設定",
    agents: "エージェント",
    agentManagement: "エージェント管理",
    agentIdentity: "エージェントID",
    connectionKeys: "接続キー",
    deletedAgents: "削除されたエージェント",
    organizations: "組織",
    organizationSettings: "組織設定",
    organizationDescription: "共有する人、チーム、ワークスペース、エージェント、アクセス境界を管理します。",
    newOrganization: "＋ 新しい組織",
    chooseOrganization: "現在の組織",
    noOrganization: "共有名前空間が必要なときに組織を作成します。個人ワークスペースは変わりません。",
    createOrganization: "組織を作成",
    organizationGeneral: "一般",
    organizationMembers: "メンバーと招待",
    organizationTeams: "チーム",
    organizationWorkspaces: "ワークスペースアクセス",
    organizationAgents: "組織エージェント",
    organizationAudit: "監査",
    organizationDelete: "組織を削除",
    workspace: "ワークスペース",
    workspaceSettings: "ワークスペース設定",
    general: "一般",
    agentPermissions: "エージェントの割り当てと権限",
    operations: "運用と監査",
    workspaceDelete: "ワークスペースを削除",
    site: "サイト",
    siteAdministration: "サイト管理",
    accountDescription: "プロフィールとアカウントのセキュリティを管理します。",
    agentsDescription: "エージェントIDと接続キーを1か所で管理します。",
    siteDescription: "登録、メール、公開URL、運用状態をNyxdocインスタンス全体で管理します。",
    workspaceDescription: "{workspace}にエージェントを割り当て、役割と文書範囲を管理します。",
    myInformation: "自分の情報",
    profileDescription: "文書の変更履歴に表示されるアカウント情報です。",
    profilePhoto: "プロフィール画像",
    chooseImage: "画像を選択",
    delete: "削除",
    displayName: "表示名",
    email: "メールアドレス",
    saved: "保存しました。",
    saving: "保存中…",
    saveChanges: "変更を保存",
    workspaceInformation: "ワークスペース情報",
    workspaceBoundary: "文書、メンバーシップ、権限、監査記録を他のワークスペースから分離する最上位の作業領域です。",
    currentWorkspace: "設定中のワークスペース",
    workspaceName: "ワークスペース名",
    saveName: "名前を保存",
    operationsDescription: "管理エージェントは権限を直接変更せずリクエストし、人による確認結果が記録されます。",
    adminRequests: "管理リクエスト",
    approvalBoundary: "承認されるまでワークスペース、エージェント、接続キーは変更されません。",
    pendingCount: "{count}件待機中",
    noAdminRequests: "エージェントからの管理リクエストはありません。",
    requestReason: "リクエスト理由",
    reviewedBy: "{name}が確認",
    reject: "拒否",
    processing: "処理中…",
    approveExecute: "承認して実行",
    recentAudit: "最近の監査記録",
    auditDescription: "権限、キー、ゴミ箱、担当などの運用変更を記録する不変ログです。",
    noAudit: "運用変更はまだ記録されていません。",
    workspaceDeleteDescription: "作業中のワークスペースだけをゴミ箱へ移動します。復元と完全削除は統合ゴミ箱で管理します。",
    workspaceAccessBlocked: "人とエージェントのアクセスは直ちに遮断されますが、文書、リビジョン、メディア、メンバーシップ、エージェント割り当ては保持されます。",
    ownerOnlyDelete: "ワークスペース所有者だけが削除できます。",
    lastWorkspace: "最後のワークスペースは削除できません。先に別のワークスペースを作成してください。",
    moveToTrash: "ゴミ箱へ移動",
    security: "セキュリティ",
    securityDescription: "ログインとアカウントアクセスを管理します。",
    emailVerified: "メール確認済み",
    resetPassword: "パスワードを再設定",
    signOut: "ログアウト",
    confirmWorkspaceTrash: "ワークスペースをゴミ箱へ移動しますか？",
    workspaceTrashExplanation: "アクセスは直ちに遮断されますが、すべてのデータは保持されます。後で文書画面の統合ゴミ箱から復元または完全削除できます。",
    typeWorkspaceName: "確認のためワークスペース名を入力してください。",
    moving: "移動中…",
    cancel: "キャンセル",
    approveQuestion: "この管理リクエストを承認しますか？",
    rejectQuestion: "この管理リクエストを拒否しますか？",
    reviewNote: "確認メモ（任意）",
    reviewNotePlaceholder: "判断理由や確認内容を記録してください。",
    rejectRequest: "リクエストを拒否",
    tokenReady: "エージェント接続キーの準備ができました。",
    tokenOnce: "このキーは今回だけ表示されます。安全な場所に保存してください。",
    copied: "コピーしました",
    copyKey: "キーをコピー",
    whichAgent: "どのエージェントに接続しますか？",
    guideFormats: "クライアントごとに設定形式は異なりますが、MCP URLと接続キーは同じです。",
    guideAria: "エージェント別接続ガイド",
    direct: "直接接続",
    openClawGuide: "OpenClawのMCP設定でnyxdocという名前を作成し、上のJSONを登録してください。続いてopenclaw mcp doctor nyxdoc --probeで確認します。キーを含む設定は共有しないでください。",
    officialGuide: "公式ガイド",
    codexGuide: "上の接続キーをNYXDOC_TOKEN環境変数に保存してからCodexを起動してください。",
    directGuide: "Streamable HTTP MCPとBearerヘッダーに対応する他のエージェントでも同じ値を使用できます。",
    stored: "保存しました",
    statusPending: "承認待ち",
    statusExecuted: "実行完了",
    statusRejected: "拒否済み",
    statusFailed: "実行失敗",
    statusExpired: "期限切れ",
  },
});

export type SettingsArea = "account" | "agents" | "organization" | "workspace" | "site";

function appReturnHref(workspaceId: string, documentId?: string) {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (documentId) query.set("document", documentId);
  return `/app?${query.toString()}`;
}

function settingsAreaHref(
  area: SettingsArea,
  workspaceId: string,
  documentId?: string,
) {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (documentId) query.set("document", documentId);
  return `/settings/${area}?${query.toString()}`;
}

function organizationSettingsHref(
  workspaceId: string,
  organizationId?: string,
) {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (organizationId) query.set("organization", organizationId);
  return `/settings/organization?${query.toString()}`;
}

function shortDate(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function adminRequestStatusLabel(
  status: AdminActionRequest["status"],
  locale: AppLocale,
) {
  const copy = SETTINGS_COPY[locale];
  return {
    pending: copy.statusPending,
    executed: copy.statusExecuted,
    rejected: copy.statusRejected,
    failed: copy.statusFailed,
    expired: copy.statusExpired,
  }[status];
}

function roleLabelForOrganization(
  role: "owner" | "admin" | "member",
  locale: AppLocale,
) {
  const copy = SETTINGS_COPY[locale];
  return role === "owner" ? copy.owner : role === "admin" ? copy.admin : copy.member;
}

export function SettingsShell({
  area,
  currentDocumentId,
  initialConnectAgent = false,
  initialWorkspaceOnboarding = false,
  initialRevealedToken = null,
  view,
}: {
  area: SettingsArea;
  currentDocumentId?: string;
  initialConnectAgent?: boolean;
  initialWorkspaceOnboarding?: boolean;
  initialRevealedToken?: string | null;
  view: SettingsView;
}) {
  const { locale, t } = useI18n();
  const copyText = SETTINGS_COPY[locale];
  const router = useRouter();
  const [profileName, setProfileName] = useState(view.user.name);
  const [profileLocale, setProfileLocale] = useState<AppLocale | "">(
    view.user.locale ?? "",
  );
  const [workspaceName, setWorkspaceName] = useState(view.workspace.name);
  const [savedProfile, setSavedProfile] = useState({
    image: view.user.image,
    locale: view.user.locale,
    name: view.user.name,
  });
  const [savedWorkspaceName, setSavedWorkspaceName] = useState(view.workspace.name);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState(view.user.image);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const avatarObjectUrlRef = useRef<string | null>(null);
  const [profilePending, setProfilePending] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [workspaceNamePending, setWorkspaceNamePending] = useState(false);
  const [workspaceNameError, setWorkspaceNameError] = useState("");
  const [workspaceNameSaved, setWorkspaceNameSaved] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(initialRevealedToken);
  const [connectionGuide, setConnectionGuide] = useState<ConnectionGuide>("openclaw");
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [organizationCreateOpen, setOrganizationCreateOpen] = useState(false);
  const [workspaceDeleteOpen, setWorkspaceDeleteOpen] = useState(false);
  const [workspaceDeleteConfirmation, setWorkspaceDeleteConfirmation] = useState("");
  const [workspaceDeletePending, setWorkspaceDeletePending] = useState(false);
  const [workspaceDeleteError, setWorkspaceDeleteError] = useState("");
  const [adminRequests, setAdminRequests] = useState(view.adminRequests);
  const [adminPendingId, setAdminPendingId] = useState<string | null>(null);
  const [adminError, setAdminError] = useState("");
  const [adminReview, setAdminReview] = useState<{
    request: AdminActionRequest;
    decision: "approve" | "reject";
  } | null>(null);
  const [adminReviewNote, setAdminReviewNote] = useState("");
  const codexConfigSnippet = `[mcp_servers.nyxdoc]\nurl = "${view.mcpUrl}"\nbearer_token_env_var = "NYXDOC_TOKEN"`;
  const openClawConfigSnippet = JSON.stringify(
    {
      url: view.mcpUrl,
      transport: "streamable-http",
      headers: { Authorization: `Bearer ${revealedToken ?? copyText.connectionKey}` },
    },
    null,
    2,
  );
  const directConfigSnippet = `MCP URL: ${view.mcpUrl}\nTransport: Streamable HTTP\nAuthorization: Bearer ${revealedToken ?? copyText.connectionKey}`;
  const guideSnippet = connectionGuide === "openclaw"
    ? openClawConfigSnippet
    : connectionGuide === "codex"
      ? codexConfigSnippet
      : directConfigSnippet;
  const guideCopyLabel = connectionGuide === "openclaw"
    ? copyText.openClawConfig
    : connectionGuide === "codex"
      ? copyText.codexConfig
      : copyText.connectionInfo;
  const normalizedProfileName = profileName.trim();
  const normalizedWorkspaceName = workspaceName.trim();
  const profileChanged =
    normalizedProfileName !== savedProfile.name
    || (profileLocale || null) !== savedProfile.locale
    || avatarFile !== null
    || (avatarRemoved && savedProfile.image !== null);
  const workspaceNameChanged = normalizedWorkspaceName !== savedWorkspaceName;
  const returnHref = appReturnHref(view.workspace.id, currentDocumentId);
  const personalWorkspaceCount = view.workspaces.filter(
    (workspace) => workspace.owner.type === "personal"
      && workspace.owner.id === view.user.id,
  ).length;
  const workspaceGroups = Array.from(view.workspaces.reduce((groups, workspace) => {
    const key = `${workspace.owner.type}:${workspace.owner.id}`;
    const current = groups.get(key) ?? {
      label: workspace.owner.type === "personal"
        ? `${workspace.owner.name} · Personal`
        : workspace.owner.name,
      workspaces: [] as typeof view.workspaces,
    };
    current.workspaces.push(workspace);
    groups.set(key, current);
    return groups;
  }, new Map<string, { label: string; workspaces: typeof view.workspaces }>()));

  function workspaceRequest(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-nyxdoc-workspace-id", view.workspace.id);
    return fetch(input, { ...init, headers });
  }

  useEffect(() => () => {
    if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current);
  }, []);

  useEffect(() => {
    rememberWorkspaceSelection(view.workspace.id);
  }, [view.workspace.id]);

  function releaseAvatarObjectUrl() {
    if (!avatarObjectUrlRef.current) return;
    URL.revokeObjectURL(avatarObjectUrlRef.current);
    avatarObjectUrlRef.current = null;
  }

  function chooseAvatar(file: File | undefined) {
    if (!file) return;
    setProfileSaved(false);
    if (!AVATAR_TYPES.has(file.type)) {
      setProfileError(copyText.invalidAvatar);
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setProfileError(copyText.avatarTooLarge);
      return;
    }
    releaseAvatarObjectUrl();
    const previewUrl = URL.createObjectURL(file);
    avatarObjectUrlRef.current = previewUrl;
    setAvatarFile(file);
    setAvatarPreviewUrl(previewUrl);
    setAvatarRemoved(false);
    setProfileError("");
  }

  function removeAvatar() {
    releaseAvatarObjectUrl();
    setAvatarFile(null);
    setAvatarPreviewUrl(null);
    setAvatarRemoved(savedProfile.image !== null);
    setProfileError("");
    setProfileSaved(false);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedProfileName || profilePending || !profileChanged) return;
    setProfilePending(true);
    setProfileError("");
    setProfileSaved(false);

    try {
      let avatarMediaId: string | null | undefined;
      if (avatarFile) {
        avatarMediaId = (await uploadMediaFile(avatarFile, view.workspace.id)).id;
      } else if (avatarRemoved) {
        avatarMediaId = null;
      }

      const response = await workspaceRequest("/api/settings/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: normalizedProfileName,
          locale: profileLocale || null,
          ...(avatarMediaId !== undefined ? { avatarMediaId } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as ProfileApiBody;
      if (!response.ok || !body.profile) {
        throw new Error(body.error || copyText.profileSaveFailed);
      }

      releaseAvatarObjectUrl();
      setAvatarFile(null);
      setAvatarRemoved(false);
      setAvatarPreviewUrl(body.profile.image);
      setProfileName(body.profile.name);
      setProfileLocale(body.profile.locale ?? "");
      setSavedProfile(body.profile);
      setProfileSaved(true);
      router.refresh();
    } catch (profileSaveError) {
      setProfileError(
        profileSaveError instanceof Error
          ? profileSaveError.message
          : copyText.profileSaveFailed,
      );
    } finally {
      setProfilePending(false);
    }
  }

  async function saveWorkspaceName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedWorkspaceName || workspaceNamePending || !workspaceNameChanged) return;
    setWorkspaceNamePending(true);
    setWorkspaceNameError("");
    setWorkspaceNameSaved(false);
    try {
      const response = await workspaceRequest("/api/settings/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: normalizedWorkspaceName }),
      });
      const body = (await response.json().catch(() => ({}))) as WorkspaceApiBody;
      if (!response.ok || !body.workspace) {
        throw new Error(body.error || copyText.workspaceSaveFailed);
      }
      setWorkspaceName(body.workspace.name);
      setSavedWorkspaceName(body.workspace.name);
      setWorkspaceNameSaved(true);
      router.refresh();
    } catch (workspaceSaveError) {
      setWorkspaceNameError(workspaceSaveError instanceof Error
        ? workspaceSaveError.message
        : copyText.workspaceSaveFailed);
    } finally {
      setWorkspaceNamePending(false);
    }
  }

  function openWorkspaceDelete() {
    setWorkspaceDeleteOpen(true);
    setWorkspaceDeleteConfirmation("");
    setWorkspaceDeleteError("");
  }

  async function deleteCurrentWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      workspaceDeletePending
      || workspaceDeleteConfirmation.trim() !== view.workspace.name
    ) return;
    setWorkspaceDeletePending(true);
    setWorkspaceDeleteError("");
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(view.workspace.id)}/trash`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmationName: workspaceDeleteConfirmation.trim(),
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as WorkspaceLifecycleApiBody;
    if (!response.ok || !body.workspace || !body.nextWorkspaceId) {
      setWorkspaceDeletePending(false);
      setWorkspaceDeleteError(
        body.error || copyText.workspaceTrashFailed,
      );
      return;
    }
    rememberWorkspaceSelection(body.nextWorkspaceId);
    window.location.assign(
      `/settings/workspace?workspace=${encodeURIComponent(body.nextWorkspaceId)}`,
    );
  }

  async function copy(value: string, kind: CopyTarget) {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  }

  async function reviewAdminRequest(
    adminRequest: AdminActionRequest,
    decision: "approve" | "reject",
    note: string | null,
  ) {
    if (adminPendingId) return;
    setAdminPendingId(adminRequest.id);
    setAdminError("");
    const response = await workspaceRequest(`/api/admin-requests/${adminRequest.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, note }),
    });
    const body = (await response.json().catch(() => ({}))) as AdminReviewApiBody;
    setAdminPendingId(null);
    if (!response.ok || !body.request) {
      setAdminError(body.error || copyText.adminRequestFailed);
      const latest = await workspaceRequest("/api/admin-requests");
      const latestBody = (await latest.json().catch(() => ({}))) as {
        requests?: AdminActionRequest[];
      };
      if (latestBody.requests) setAdminRequests(latestBody.requests);
      return;
    }
    setAdminReview(null);
    setAdminReviewNote("");
    setAdminRequests((current) => current.map((item) => (
      item.id === body.request!.id ? body.request! : item
    )));
    if (body.revealedToken) setRevealedToken(body.revealedToken);
    router.refresh();
  }

  async function signOut() {
    await authClient.signOut();
    window.location.href = "/sign-in";
  }

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link href={returnHref} className={styles.brand}><span><NyxdocMark size={38} /></span>nyxdoc</Link>
        <Link href={returnHref} className={styles.backLink}><ArrowLeft size={16} /> {copyText.backToDocuments}</Link>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.profileSummary}>
            <UserAvatar
              className={styles.profileSummaryAvatar}
              imageUrl={avatarPreviewUrl}
              name={profileName}
            />
            <div><strong>{profileName || view.user.name}</strong><small>{view.user.email}</small></div>
          </div>
          {area === "site" ? (
            <div className={styles.globalSitePanel}>
              <span><Globe2 size={19} /></span>
              <div>
                <strong>{copyText.wholeSite}</strong>
                <small>
                  {view.siteAdministratorRole === "owner"
                    ? copyText.siteOwner
                    : copyText.siteAdministrator}
                  {" · "}{copyText.wholeSiteHint}
                </small>
              </div>
            </div>
          ) : area === "organization" ? (
            <div className={styles.workspacePanel}>
              <label>
                <span>{copyText.chooseOrganization}</span>
                <select
                  value={view.organization?.organization.id ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "__create_organization__") {
                      setOrganizationCreateOpen(true);
                      return;
                    }
                    router.push(organizationSettingsHref(view.workspace.id, value));
                  }}
                >
                  {!view.organization && <option value="">{copyText.organizations}</option>}
                  {view.organizations.map((organization) => (
                    <option value={organization.id} key={organization.id}>
                      {organization.icon ? `${organization.icon} ` : ""}{organization.name}
                    </option>
                  ))}
                  <option disabled>──────────</option>
                  <option value="__create_organization__">{copyText.newOrganization}</option>
                </select>
              </label>
              <small>{view.organization
                ? `${roleLabelForOrganization(view.organization.organization.role, locale)} · ${copyText.organizationDescription}`
                : copyText.noOrganization}</small>
            </div>
          ) : (
            <div className={styles.workspacePanel}>
              <label>
                <span>{copyText.activeWorkspace}</span>
                <select
                  value={view.workspace.id}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === CREATE_WORKSPACE_OPTION_VALUE) {
                      setWorkspaceCreateOpen(true);
                      return;
                    }
                    rememberWorkspaceSelection(value);
                    router.push(settingsAreaHref(area, value));
                  }}
                >
                  {workspaceGroups.map(([key, group]) => (
                    <optgroup label={group.label} key={key}>
                      {group.workspaces.map((workspace) => (
                        <option value={workspace.id} key={workspace.id}>{workspace.name}</option>
                      ))}
                    </optgroup>
                  ))}
                  <option disabled>──────────</option>
                  <option value={CREATE_WORKSPACE_OPTION_VALUE}>{copyText.newWorkspace}</option>
                </select>
              </label>
              <small>
                {view.workspace.role === "owner"
                  ? copyText.owner
                  : view.workspace.role === "admin"
                    ? copyText.admin
                    : view.workspace.role === "editor"
                      ? copyText.editor
                      : copyText.viewer}
                {" · "}{copyText.boundaryHint}
              </small>
            </div>
          )}
          <nav aria-label={copyText.settingsMenu}>
            <span className={styles.navGroupLabel}>{copyText.myAccount}</span>
            <Link
              href={settingsAreaHref("account", view.workspace.id, currentDocumentId)}
              data-active={area === "account"}
              aria-current={area === "account" ? "page" : undefined}
            ><UserRound size={16} /> {copyText.accountSettings}</Link>
            <span className={styles.navGroupLabel}>{copyText.agents}</span>
            <Link
              href={settingsAreaHref("agents", view.workspace.id, currentDocumentId)}
              data-active={area === "agents"}
              aria-current={area === "agents" ? "page" : undefined}
            ><Bot size={16} /> {copyText.agentManagement}</Link>
            {area === "agents" && <>
              <a className={styles.navSubLink} href="#agent-identities">{copyText.agentIdentity}</a>
              <a className={styles.navSubLink} href="#agent-credentials">{copyText.connectionKeys}</a>
              <a className={styles.navSubLink} href="#deleted-agents">{copyText.deletedAgents}</a>
            </>}
            <span className={styles.navGroupLabel}>{copyText.organizations}</span>
            <Link
              href={organizationSettingsHref(
                view.workspace.id,
                view.organization?.organization.id ?? view.organizations[0]?.id,
              )}
              data-active={area === "organization"}
              aria-current={area === "organization" ? "page" : undefined}
            ><UsersRound size={16} /> {copyText.organizationSettings}</Link>
            {area === "organization" && view.organization && <>
              <a className={styles.navSubLink} href="#organization-general">{copyText.organizationGeneral}</a>
              <a className={styles.navSubLink} href="#organization-members">{copyText.organizationMembers}</a>
              <a className={styles.navSubLink} href="#organization-teams">{copyText.organizationTeams}</a>
              <a className={styles.navSubLink} href="#organization-workspaces">{copyText.organizationWorkspaces}</a>
              <a className={styles.navSubLink} href="#organization-agents">{copyText.organizationAgents}</a>
              {view.organization.permissions.canReadAudit && <a className={styles.navSubLink} href="#organization-audit">{copyText.organizationAudit}</a>}
              {view.organization.permissions.canTrash && <a className={styles.navSubLink} href="#organization-danger">{copyText.organizationDelete}</a>}
            </>}
            <span className={styles.navGroupLabel}>{copyText.workspace}</span>
            <Link
              href={settingsAreaHref("workspace", view.workspace.id, currentDocumentId)}
              data-active={area === "workspace"}
              aria-current={area === "workspace" ? "page" : undefined}
            ><Building2 size={16} /> {copyText.workspaceSettings}</Link>
            {area === "workspace" && <>
              <a className={styles.navSubLink} href="#workspace-general">{copyText.general}</a>
              <a className={styles.navSubLink} href="#workspace-agents">{copyText.agentPermissions}</a>
              {(view.permissions.canReviewAdminRequests || view.permissions.canReadAudit) && (
                <a className={styles.navSubLink} href="#operations">{copyText.operations}</a>
              )}
              <a className={styles.navSubLink} href="#workspace-danger">{copyText.workspaceDelete}</a>
            </>}
            {view.isSiteAdministrator && <>
              <span className={styles.navGroupLabel}>{copyText.site}</span>
              <Link
                href={settingsAreaHref("site", view.workspace.id, currentDocumentId)}
                data-active={area === "site"}
                aria-current={area === "site" ? "page" : undefined}
              ><Globe2 size={16} /> {copyText.siteAdministration}</Link>
            </>}
          </nav>
        </aside>

        <section className={styles.content}>
          <header className={styles.pageHeader}>
            <p>{area === "account"
              ? "ACCOUNT"
              : area === "agents"
                ? "AGENT"
                : area === "organization"
                  ? "ORGANIZATION"
                : area === "site"
                  ? "SITE"
                  : "WORKSPACE"} SETTINGS</p>
            <h1>{area === "account"
              ? t("settings.account.title")
              : area === "agents"
                ? copyText.agents
                : area === "organization"
                  ? view.organization?.organization.name ?? copyText.organizations
                : area === "site"
                  ? t("settings.site.title")
                  : copyText.workspaceSettings}</h1>
            <span>{area === "account"
              ? copyText.accountDescription
              : area === "agents"
                ? copyText.agentsDescription
                : area === "organization"
                  ? copyText.organizationDescription
                : area === "site"
                  ? copyText.siteDescription
                  : formatCopy(copyText.workspaceDescription, {
                    workspace: view.workspace.name,
                  })}</span>
          </header>

          {area === "site" && view.site && (
            <SiteAdministrationPanel initialSite={view.site} />
          )}

          {area === "organization" && view.organization && (
            <OrganizationSettingsPanel
              key={`${view.organization.organization.id}:${view.organization.organization.updatedAt}:${view.organization.members.length}:${view.organization.teams.length}:${view.organization.workspaceGrants.length}:${view.organization.workspaceMemberGrants.length}`}
              initialView={view.organization}
              agents={view.organizationAgents}
              mcpUrl={view.mcpUrl}
              uploadWorkspaceId={view.workspace.id}
              accessibleWorkspaces={view.workspaces}
              currentUserId={view.user.id}
            />
          )}

          {area === "organization" && !view.organization && (
            <section className={styles.settingsCard}>
              <div className={styles.sectionHeading}>
                <span><Building2 size={18} /></span>
                <div><h2>{copyText.organizations}</h2><p>{copyText.noOrganization}</p></div>
              </div>
              <button type="button" onClick={() => setOrganizationCreateOpen(true)}>
                <Plus size={15} /> {copyText.createOrganization}
              </button>
            </section>
          )}

          {area === "organization" && (
            <OrganizationDirectory
              trashedOrganizations={view.trashedOrganizations}
              workspaceId={view.workspace.id}
            />
          )}

          {area === "account" && <section className={styles.settingsCard} id="profile">
            <div className={styles.sectionHeading}>
              <span><UserRound size={18} /></span>
              <div><h2>{copyText.myInformation}</h2><p>{copyText.profileDescription}</p></div>
            </div>
            <form className={styles.profileForm} onSubmit={saveProfile}>
              <div className={styles.avatarEditor}>
                <UserAvatar
                  className={styles.profileAvatar}
                  imageUrl={avatarPreviewUrl}
                  name={profileName}
                />
                <div>
                  <strong>{copyText.profilePhoto}</strong>
                  <small>{copyText.avatarFormats}</small>
                  <div className={styles.avatarActions}>
                    <label>
                      <ImagePlus size={15} /> {copyText.chooseImage}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        disabled={profilePending}
                        onChange={(event) => {
                          chooseAvatar(event.target.files?.[0]);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                    {avatarPreviewUrl && (
                      <button type="button" onClick={removeAvatar} disabled={profilePending}>
                        <X size={14} /> {copyText.delete}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className={styles.profileFields}>
                <label>
                  <span>{copyText.displayName}</span>
                  <input
                    value={profileName}
                    onChange={(event) => {
                      setProfileName(event.target.value);
                      setProfileSaved(false);
                    }}
                    minLength={1}
                    maxLength={80}
                    required
                  />
                </label>
                <label>
                  <span>{copyText.email}</span>
                  <input value={view.user.email} disabled readOnly />
                </label>
                <label>
                  <span>{t("common.language")}</span>
                  <select
                    value={profileLocale}
                    onChange={(event) => {
                      setProfileLocale(event.target.value as AppLocale | "");
                      setProfileSaved(false);
                    }}
                  >
                    <option value="">{t("settings.language.browser")}</option>
                    {SUPPORTED_LOCALES.map((locale) => (
                      <option key={locale} value={locale}>{localeLabel(locale)}</option>
                    ))}
                  </select>
                  <small>{t("settings.language.description")}</small>
                </label>
              </div>
              <footer className={styles.profileFooter}>
                <div aria-live="polite">
                  {profileError && <span className={styles.profileError} role="alert">{profileError}</span>}
                  {profileSaved && <span className={styles.profileSaved} role="status"><Check size={14} /> {copyText.saved}</span>}
                </div>
                <button
                  type="submit"
                  disabled={
                    profilePending
                    || !profileChanged
                    || !normalizedProfileName
                  }
                >
                  <Save size={15} /> {profilePending ? copyText.saving : copyText.saveChanges}
                </button>
              </footer>
            </form>
          </section>}

          {area === "workspace" && <section className={styles.settingsCard} id="workspace-general">
            <div className={styles.sectionHeading}>
              <span><Building2 size={18} /></span>
              <div>
                <h2>{copyText.workspaceInformation}</h2>
                <p>{copyText.workspaceBoundary}</p>
              </div>
            </div>
            <div className={styles.workspaceBoundaryNotice}>
              <Building2 size={18} />
              <div>
                <strong>{view.workspace.name}</strong>
                <small>
                  {copyText.currentWorkspace}
                  {" · "}
                  {view.workspace.role === "owner"
                    ? copyText.owner
                    : view.workspace.role === "admin"
                      ? copyText.admin
                      : view.workspace.role === "editor"
                        ? copyText.editor
                        : copyText.viewer}
                </small>
              </div>
            </div>
            <form className={styles.workspaceNameForm} onSubmit={saveWorkspaceName}>
              <label>
                <span>{copyText.workspaceName}</span>
                <input
                  value={workspaceName}
                  onChange={(event) => {
                    setWorkspaceName(event.target.value);
                    setWorkspaceNameSaved(false);
                  }}
                  minLength={1}
                  maxLength={120}
                  required
                  disabled={!view.permissions.canManageWorkspace || workspaceNamePending}
                />
              </label>
              <button
                type="submit"
                disabled={!view.permissions.canManageWorkspace || workspaceNamePending || !workspaceNameChanged || !normalizedWorkspaceName}
              ><Save size={15} /> {workspaceNamePending ? copyText.saving : copyText.saveName}</button>
            </form>
            <div className={styles.workspaceFormStatus} aria-live="polite">
              {workspaceNameError && <span className={styles.profileError} role="alert">{workspaceNameError}</span>}
              {workspaceNameSaved && <span className={styles.profileSaved} role="status"><Check size={14} /> {copyText.saved}</span>}
            </div>
          </section>}

          {area === "agents" && <AccountAgentsPanel
            key={view.accountAgents.map((agent) => `${agent.id}:${agent.updatedAt}:${agent.deletedAt ?? ""}:${agent.purgedAt ?? ""}:${agent.credentials.map((credential) => `${credential.id}:${credential.revokedAt ?? ""}:${credential.expiresAt ?? ""}`).join(",")}:${agent.memberships.map((membership) => `${membership.membershipId}:${membership.updatedAt}`).join(",")}`).join("|")}
            initialAgents={view.accountAgents}
            mcpUrl={view.mcpUrl}
            uploadWorkspaceId={view.workspace.id}
            workspaces={view.workspaces}
          />}

          {area === "workspace" && <WorkspaceAgentsPanel
            key={`${view.workspace.id}:${view.workspaceAgentMemberships.map((membership) => `${membership.membershipId}:${membership.updatedAt}`).join(",")}`}
            accountAgents={view.workspaceAssignableAgents}
            documents={view.documents}
            initiallyOpen={initialConnectAgent}
            onboardingCompletionHref={initialWorkspaceOnboarding
              ? `/app?workspace=${encodeURIComponent(view.workspace.id)}`
              : undefined}
            initialMemberships={view.workspaceAgentMemberships}
            mcpUrl={view.mcpUrl}
            workspace={view.workspace}
          />}

          {area === "workspace" && (view.permissions.canReviewAdminRequests || view.permissions.canReadAudit) && (
            <section className={styles.settingsCard} id="operations">
              <div className={styles.sectionHeading}>
                <span><ShieldCheck size={18} /></span>
                <div>
                  <h2>{copyText.operations}</h2>
                  <p>{copyText.operationsDescription}</p>
                </div>
              </div>

              {view.permissions.canReviewAdminRequests && (
                <div className={styles.operationSection}>
                  <div className={styles.operationHeading}>
                    <div>
                      <strong>{copyText.adminRequests}</strong>
                      <small>{copyText.approvalBoundary}</small>
                    </div>
                    <em>{formatCopy(copyText.pendingCount, {
                      count: adminRequests.filter((item) => item.status === "pending").length,
                    })}</em>
                  </div>
                  <div className={styles.adminRequestList}>
                    {adminRequests.length === 0 ? (
                      <div className={styles.emptyOperation}>{copyText.noAdminRequests}</div>
                    ) : adminRequests.map((adminRequest) => (
                      <article className={styles.adminRequest} data-status={adminRequest.status} key={adminRequest.id}>
                        <header>
                          <div>
                            <code>{adminRequest.actionType}</code>
                            <strong>{adminRequest.requestedByLabel}</strong>
                          </div>
                          <span>{adminRequestStatusLabel(adminRequest.status, locale)}</span>
                        </header>
                        <p>{adminRequest.preview}</p>
                        <small>
                          {copyText.requestReason}: {adminRequest.reason}
                          {" · "}{shortDate(adminRequest.requestedAt, locale)}
                          {adminRequest.reviewedByLabel
                            ? ` · ${formatCopy(copyText.reviewedBy, {
                              name: adminRequest.reviewedByLabel,
                            })}`
                            : ""}
                        </small>
                        {adminRequest.status === "pending" && (
                          <footer>
                            <button
                              type="button"
                              onClick={() => {
                                setAdminReview({ request: adminRequest, decision: "reject" });
                                setAdminReviewNote("");
                              }}
                              disabled={Boolean(adminPendingId)}
                            >
                              <X size={14} /> {copyText.reject}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setAdminReview({ request: adminRequest, decision: "approve" });
                                setAdminReviewNote("");
                              }}
                              disabled={Boolean(adminPendingId)}
                            >
                              <Check size={14} /> {adminPendingId === adminRequest.id
                                ? copyText.processing
                                : copyText.approveExecute}
                            </button>
                          </footer>
                        )}
                      </article>
                    ))}
                  </div>
                  {adminError && <div className={styles.inlineError} role="alert">{adminError}</div>}
                </div>
              )}

              {view.permissions.canReadAudit && (
                <div className={styles.operationSection}>
                  <div className={styles.operationHeading}>
                    <div>
                      <strong>{copyText.recentAudit}</strong>
                      <small>{copyText.auditDescription}</small>
                    </div>
                  </div>
                  <div className={styles.auditList}>
                    {view.auditEvents.length === 0 ? (
                      <div className={styles.emptyOperation}>{copyText.noAudit}</div>
                    ) : view.auditEvents.map((event) => (
                      <div className={styles.auditItem} key={event.id}>
                        <span data-outcome={event.outcome} />
                        <div>
                          <strong>{event.action}</strong>
                          <small>{event.actorLabel} · {event.targetType}{event.targetId ? ` · ${event.targetId}` : ""}</small>
                        </div>
                        <time dateTime={event.createdAt}>{shortDate(event.createdAt, locale)}</time>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {area === "workspace" && (
            <section
              className={`${styles.settingsCard} ${styles.workspaceDangerCard}`}
              id="workspace-danger"
            >
              <div className={styles.sectionHeading}>
                <span className={styles.deletedSectionIcon}><Trash2 size={18} /></span>
                <div>
                  <h2>{copyText.workspaceDelete}</h2>
                  <p>{copyText.workspaceDeleteDescription}</p>
                </div>
              </div>
              <div className={styles.workspaceDangerZone}>
                <div>
                  <strong>{view.workspace.name}</strong>
                  <small>
                    {copyText.workspaceAccessBlocked}
                  </small>
                  {!view.permissions.canTrashWorkspace && (
                    <em>{copyText.ownerOnlyDelete}</em>
                  )}
                  {view.workspace.owner.type === "personal" && personalWorkspaceCount <= 1 && (
                    <em>{copyText.lastWorkspace}</em>
                  )}
                </div>
                <button
                  type="button"
                  disabled={
                    !view.permissions.canTrashWorkspace
                    || (view.workspace.owner.type === "personal" && personalWorkspaceCount <= 1)
                    || workspaceDeletePending
                  }
                  onClick={openWorkspaceDelete}
                ><Trash2 size={15} /> {copyText.moveToTrash}</button>
              </div>
            </section>
          )}

          {area === "account" && <section className={styles.settingsCard} id="security">
            <div className={styles.sectionHeading}>
              <span><LockKeyhole size={18} /></span>
              <div><h2>{copyText.security}</h2><p>{copyText.securityDescription}</p></div>
            </div>
            <div className={styles.securityRow}>
              <div><MailCheck size={18} /><span><strong>{copyText.emailVerified}</strong><small>{view.user.email}</small></span></div>
              <Link href="/forgot-password">{copyText.resetPassword}</Link>
            </div>
            <button className={styles.signOutButton} onClick={signOut}><LogOut size={16} /> {copyText.signOut}</button>
          </section>}
        </section>
      </div>

      {workspaceCreateOpen && (
        <WorkspaceCreateDialog
          organizations={view.organizations.filter(
            (organization) => organization.role === "owner" || organization.role === "admin",
          )}
          initialOrganizationId={view.workspace.owner.type === "organization"
            ? view.workspace.owner.id
            : null}
          onClose={() => setWorkspaceCreateOpen(false)}
        />
      )}

      {organizationCreateOpen && (
        <OrganizationCreateDialog
          workspaceId={view.workspace.id}
          onClose={() => setOrganizationCreateOpen(false)}
        />
      )}

      {workspaceDeleteOpen && (
        <div className={styles.modalBackdrop} role="presentation">
          <form
            className={styles.workspaceLifecycleModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-delete-title"
            onSubmit={deleteCurrentWorkspace}
          >
            <div><AlertTriangle size={21} /></div>
            <p>WORKSPACE TO TRASH</p>
            <h2 id="workspace-delete-title">{copyText.confirmWorkspaceTrash}</h2>
            <span>{copyText.workspaceTrashExplanation}</span>
            <label>
              <span>{copyText.typeWorkspaceName}</span>
              <strong>{view.workspace.name}</strong>
              <input
                autoFocus
                autoComplete="off"
                value={workspaceDeleteConfirmation}
                onChange={(event) => setWorkspaceDeleteConfirmation(event.target.value)}
              />
            </label>
            {workspaceDeleteError && (
              <div className={styles.workspaceLifecycleError} role="alert">
                {workspaceDeleteError}
              </div>
            )}
            <footer>
              <button
                type="button"
                disabled={workspaceDeletePending}
                onClick={() => {
                  setWorkspaceDeleteOpen(false);
                  setWorkspaceDeleteConfirmation("");
                  setWorkspaceDeleteError("");
                }}
              >{copyText.cancel}</button>
              <button
                type="submit"
                disabled={
                  workspaceDeletePending
                  || workspaceDeleteConfirmation.trim() !== view.workspace.name
                }
              >
                <Trash2 size={14} />
                {workspaceDeletePending ? copyText.moving : copyText.moveToTrash}
              </button>
            </footer>
          </form>
        </div>
      )}

      {adminReview && (
        <div className={styles.modalBackdrop} role="presentation">
          <section className={styles.reviewModal} role="dialog" aria-modal="true" aria-labelledby="admin-review-title">
            <div className={styles.reviewModalIcon} data-decision={adminReview.decision}>
              {adminReview.decision === "approve" ? <Check size={20} /> : <X size={20} />}
            </div>
            <p>{adminReview.request.actionType}</p>
            <h2 id="admin-review-title">
              {adminReview.decision === "approve"
                ? copyText.approveQuestion
                : copyText.rejectQuestion}
            </h2>
            <span>{adminReview.request.preview}</span>
            <label>
              <span>{copyText.reviewNote}</span>
              <textarea
                value={adminReviewNote}
                onChange={(event) => setAdminReviewNote(event.target.value)}
                maxLength={1000}
                placeholder={copyText.reviewNotePlaceholder}
              />
            </label>
            <footer>
              <button
                type="button"
                onClick={() => {
                  setAdminReview(null);
                  setAdminReviewNote("");
                }}
                disabled={Boolean(adminPendingId)}
              >{copyText.cancel}</button>
              <button
                type="button"
                data-decision={adminReview.decision}
                disabled={Boolean(adminPendingId)}
                onClick={() => void reviewAdminRequest(
                  adminReview.request,
                  adminReview.decision,
                  adminReviewNote.trim() || null,
                )}
              >
                {adminPendingId
                  ? copyText.processing
                  : adminReview.decision === "approve"
                    ? copyText.approveExecute
                    : copyText.rejectRequest}
              </button>
            </footer>
          </section>
        </div>
      )}

      {revealedToken && (
        <div className={styles.modalBackdrop} role="presentation">
          <section className={styles.tokenModal} role="dialog" aria-modal="true" aria-labelledby="token-title">
            <div className={styles.tokenSuccess}><Check size={20} /></div>
            <p>CONNECTED TO NYXDOC</p>
            <h2 id="token-title">{copyText.tokenReady}</h2>
            <span>{copyText.tokenOnce}</span>
            <div className={styles.secretBox}><code>{revealedToken}</code><button onClick={() => copy(revealedToken, "token")}><Copy size={14} /> {copied === "token" ? copyText.copied : copyText.copyKey}</button></div>
            <div className={styles.guideSection}>
              <div className={styles.guideHeader}><strong>{copyText.whichAgent}</strong><small>{copyText.guideFormats}</small></div>
              <div className={styles.guideTabs} role="tablist" aria-label={copyText.guideAria}>
                <button type="button" role="tab" aria-selected={connectionGuide === "openclaw"} onClick={() => setConnectionGuide("openclaw")}>OpenClaw</button>
                <button type="button" role="tab" aria-selected={connectionGuide === "codex"} onClick={() => setConnectionGuide("codex")}>Codex</button>
                <button type="button" role="tab" aria-selected={connectionGuide === "direct"} onClick={() => setConnectionGuide("direct")}>{copyText.direct}</button>
              </div>
              <div className={styles.configBox} role="tabpanel">
                <pre>{guideSnippet}</pre>
                <button onClick={() => copy(guideSnippet, connectionGuide)}><Copy size={14} /> {copied === connectionGuide
                  ? copyText.copied
                  : formatCopy(copyText.copyValue, { name: guideCopyLabel })}</button>
              </div>
              {connectionGuide === "openclaw" && (
                <small className={styles.guideNote}>
                  {copyText.openClawGuide}{" "}
                  <a href="https://docs.openclaw.ai/cli/mcp" target="_blank" rel="noreferrer">{copyText.officialGuide}</a>
                </small>
              )}
              {connectionGuide === "codex" && <small className={styles.guideNote}>{copyText.codexGuide}</small>}
              {connectionGuide === "direct" && <small className={styles.guideNote}>{copyText.directGuide}</small>}
            </div>
            <button className={styles.doneButton} onClick={() => { setRevealedToken(null); setCopied(null); setConnectionGuide("openclaw"); }}>{copyText.stored}</button>
          </section>
        </div>
      )}
    </main>
  );
}
