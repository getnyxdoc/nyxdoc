"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import {
  Building2,
  Check,
  ClipboardCopy,
  History,
  MailPlus,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  UserMinus,
  UsersRound,
  X,
} from "lucide-react";
import { AccountAgentsPanel } from "@/components/settings/agent-management";
import { WorkspaceCreateDialog } from "@/components/workspace/workspace-create-dialog";
import { UserAvatar } from "@/components/profile/user-avatar";
import { useI18n } from "@/lib/i18n/client";
import { localeTag, type AppLocale } from "@/lib/i18n/locales";
import type { AccountAgentSummary } from "@/lib/agents/service";
import type {
  OrganizationMemberSummary,
  OrganizationRole,
  OrganizationSummary,
  OrganizationView,
  TeamSummary,
} from "@/lib/organizations/service";
import type { WorkspaceSummary } from "@/lib/workspaces/service";
import styles from "./organization-settings.module.css";

type ApiBody = { error?: string; [key: string]: unknown };
type GrantRole = "admin" | "editor" | "viewer";

function copyFor(locale: AppLocale) {
  return {
    en: {
      requestFailed: "The organization change could not be saved.",
      general: "Organization profile",
      generalDescription: "This namespace owns its workspaces, teams, agents, and audit records.",
      icon: "Short icon",
      iconHint: "Use an emoji or up to 8 characters.",
      name: "Organization name",
      save: "Save",
      saving: "Saving…",
      saved: "Saved.",
      members: "People and invitations",
      membersDescription: "Organization membership identifies people. It does not grant document access by itself.",
      inviteEmail: "Email (optional for a one-time link)",
      inviteRole: "Organization role",
      invite: "Create invitation",
      owner: "Owner",
      admin: "Administrator",
      member: "Member",
      inviteReady: "One-time invitation link",
      inviteReadyHint: "This link is shown only now. Send it through a trusted channel.",
      copy: "Copy",
      copied: "Copied",
      activeInvitations: "Active invitations",
      noInvitations: "No active invitations.",
      revoke: "Revoke",
      removeMember: "Remove member",
      currentUser: "you",
      teams: "Teams",
      teamsDescription: "Teams are flat groups. Add them to a workspace with one explicit access role.",
      teamName: "Team name",
      teamDescription: "Description (optional)",
      createTeam: "Create team",
      noTeams: "No teams yet.",
      addMember: "Add member",
      chooseMember: "Choose a member",
      deleteTeam: "Delete team",
      workspaces: "Workspace access",
      workspacesDescription: "Organization membership alone grants no content access. Assign a person or team explicitly.",
      createWorkspace: "New organization workspace",
      noWorkspaces: "No organization workspaces yet.",
      people: "Direct people",
      teamAccess: "Team access",
      noDirectAccess: "No direct people assigned.",
      noTeamAccess: "No teams assigned.",
      addAccess: "Add access",
      directPerson: "Person",
      team: "Team",
      choosePrincipal: "Choose",
      viewer: "Viewer",
      editor: "Editor",
      workspaceAdmin: "Workspace administrator",
      removeAccess: "Remove access",
      openWorkspace: "Open workspace",
      agents: "Organization agents",
      agentsReadOnly: "Organization agents",
      agentsReadOnlyHint: "Only organization owners and administrators can change identities and keys.",
      noAgents: "No organization agents.",
      audit: "Organization audit",
      auditDescription: "Recent membership, team, workspace, agent, and lifecycle changes.",
      noAudit: "No organization activity has been recorded.",
      danger: "Delete organization",
      dangerDescription: "Move the organization to trash for 30 days. Access to all owned workspaces is blocked immediately while data is preserved.",
      deletedOrganizations: "Deleted organizations",
      deletedOrganizationsDescription: "Restore a deleted organization before its retention period ends.",
      trash: "Move to trash",
      confirmTrash: "Enter the organization name to confirm.",
      cancel: "Cancel",
      restore: "Restore",
    },
    ko: {
      requestFailed: "조직 변경사항을 저장하지 못했습니다.",
      general: "조직 정보",
      generalDescription: "이 네임스페이스가 워크스페이스·팀·에이전트와 감사 기록을 소유합니다.",
      icon: "짧은 아이콘",
      iconHint: "이모지 또는 8자 이하의 문자를 사용하세요.",
      name: "조직 이름",
      save: "저장",
      saving: "저장 중…",
      saved: "저장되었습니다.",
      members: "사람과 초대",
      membersDescription: "조직 멤버십은 사람의 소속만 나타냅니다. 이것만으로 문서 접근 권한이 생기지는 않습니다.",
      inviteEmail: "이메일 (비우면 일회용 링크 초대)",
      inviteRole: "조직 역할",
      invite: "초대 만들기",
      owner: "소유자",
      admin: "관리자",
      member: "멤버",
      inviteReady: "일회용 초대 링크",
      inviteReadyHint: "이 링크는 지금 한 번만 표시됩니다. 신뢰할 수 있는 경로로 전달하세요.",
      copy: "복사",
      copied: "복사됨",
      activeInvitations: "사용 가능한 초대",
      noInvitations: "사용 가능한 초대가 없습니다.",
      revoke: "초대 취소",
      removeMember: "멤버 제외",
      currentUser: "나",
      teams: "팀",
      teamsDescription: "팀은 중첩되지 않는 단순 그룹입니다. 워크스페이스마다 명시적인 역할로 배정합니다.",
      teamName: "팀 이름",
      teamDescription: "설명 (선택)",
      createTeam: "팀 만들기",
      noTeams: "아직 팀이 없습니다.",
      addMember: "멤버 추가",
      chooseMember: "멤버 선택",
      deleteTeam: "팀 삭제",
      workspaces: "워크스페이스 접근 권한",
      workspacesDescription: "조직에 가입한 것만으로는 내용이 보이지 않습니다. 사람이나 팀을 명시적으로 배정하세요.",
      createWorkspace: "조직 워크스페이스 만들기",
      noWorkspaces: "아직 조직 워크스페이스가 없습니다.",
      people: "직접 배정한 사람",
      teamAccess: "배정한 팀",
      noDirectAccess: "직접 배정된 사람이 없습니다.",
      noTeamAccess: "배정된 팀이 없습니다.",
      addAccess: "접근 권한 추가",
      directPerson: "사람",
      team: "팀",
      choosePrincipal: "대상 선택",
      viewer: "뷰어",
      editor: "편집자",
      workspaceAdmin: "워크스페이스 관리자",
      removeAccess: "접근 해제",
      openWorkspace: "워크스페이스 열기",
      agents: "조직 에이전트",
      agentsReadOnly: "조직 에이전트",
      agentsReadOnlyHint: "조직 소유자와 관리자만 에이전트 신원과 키를 변경할 수 있습니다.",
      noAgents: "조직 에이전트가 없습니다.",
      audit: "조직 감사 기록",
      auditDescription: "최근 멤버·팀·워크스페이스·에이전트·수명주기 변경 기록입니다.",
      noAudit: "아직 기록된 조직 활동이 없습니다.",
      danger: "조직 삭제",
      dangerDescription: "조직을 30일 동안 휴지통으로 옮깁니다. 데이터는 보존되지만 모든 산하 워크스페이스 접근은 즉시 차단됩니다.",
      deletedOrganizations: "삭제된 조직",
      deletedOrganizationsDescription: "보존 기간이 끝나기 전에 삭제된 조직을 복구할 수 있습니다.",
      trash: "휴지통으로 이동",
      confirmTrash: "확인하려면 조직 이름을 입력하세요.",
      cancel: "취소",
      restore: "복구",
    },
    ja: {
      requestFailed: "組織の変更を保存できませんでした。",
      general: "組織プロフィール",
      generalDescription: "この名前空間がワークスペース、チーム、エージェント、監査記録を所有します。",
      icon: "短いアイコン",
      iconHint: "絵文字または8文字以内で入力してください。",
      name: "組織名",
      save: "保存",
      saving: "保存中…",
      saved: "保存しました。",
      members: "メンバーと招待",
      membersDescription: "組織メンバーシップは所属のみを示し、それだけでは文書アクセスを付与しません。",
      inviteEmail: "メール（空欄なら一度限りのリンク）",
      inviteRole: "組織ロール",
      invite: "招待を作成",
      owner: "オーナー",
      admin: "管理者",
      member: "メンバー",
      inviteReady: "一度限りの招待リンク",
      inviteReadyHint: "このリンクは今だけ表示されます。信頼できる経路で送ってください。",
      copy: "コピー",
      copied: "コピー済み",
      activeInvitations: "有効な招待",
      noInvitations: "有効な招待はありません。",
      revoke: "取り消す",
      removeMember: "メンバーを削除",
      currentUser: "自分",
      teams: "チーム",
      teamsDescription: "チームは入れ子にしない単純なグループです。ワークスペースごとに明示的なロールを割り当てます。",
      teamName: "チーム名",
      teamDescription: "説明（任意）",
      createTeam: "チームを作成",
      noTeams: "チームはまだありません。",
      addMember: "メンバーを追加",
      chooseMember: "メンバーを選択",
      deleteTeam: "チームを削除",
      workspaces: "ワークスペースアクセス",
      workspacesDescription: "組織参加だけでは内容へアクセスできません。人またはチームを明示的に割り当てます。",
      createWorkspace: "組織ワークスペースを作成",
      noWorkspaces: "組織ワークスペースはまだありません。",
      people: "直接割り当てた人",
      teamAccess: "割り当てたチーム",
      noDirectAccess: "直接割り当てた人はいません。",
      noTeamAccess: "割り当てたチームはありません。",
      addAccess: "アクセスを追加",
      directPerson: "人",
      team: "チーム",
      choosePrincipal: "対象を選択",
      viewer: "閲覧者",
      editor: "編集者",
      workspaceAdmin: "ワークスペース管理者",
      removeAccess: "アクセス解除",
      openWorkspace: "ワークスペースを開く",
      agents: "組織エージェント",
      agentsReadOnly: "組織エージェント",
      agentsReadOnlyHint: "組織のオーナーと管理者だけがIDとキーを変更できます。",
      noAgents: "組織エージェントはありません。",
      audit: "組織監査",
      auditDescription: "最近のメンバー、チーム、ワークスペース、エージェント、ライフサイクル変更です。",
      noAudit: "組織アクティビティはまだありません。",
      danger: "組織を削除",
      dangerDescription: "組織を30日間ゴミ箱へ移動します。データは保持されますが、所有ワークスペースへのアクセスは直ちに停止します。",
      deletedOrganizations: "削除された組織",
      deletedOrganizationsDescription: "保持期間が終了する前に削除された組織を復元できます。",
      trash: "ゴミ箱へ移動",
      confirmTrash: "確認のため組織名を入力してください。",
      cancel: "キャンセル",
      restore: "復元",
    },
  }[locale];
}

function roleLabel(role: OrganizationRole | GrantRole, locale: AppLocale) {
  const copy = copyFor(locale);
  if (role === "owner") return copy.owner;
  if (role === "admin") return copy.admin;
  if (role === "editor") return copy.editor;
  if (role === "viewer") return copy.viewer;
  return copy.member;
}

function dateLabel(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function apiRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(path, init);
  const body = response.status === 204
    ? ({} as ApiBody)
    : await response.json().catch(() => ({} as ApiBody)) as ApiBody;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Request failed");
  return body;
}

function TeamCard({
  organizationId,
  team,
  members,
  canManage,
  onChanged,
}: {
  organizationId: string;
  team: TeamSummary;
  members: OrganizationMemberSummary[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const { locale } = useI18n();
  const copy = copyFor(locale);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description);
  const [memberId, setMemberId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const availableMembers = members.filter(
    (member) => !team.members.some((teamMember) => teamMember.userId === member.userId),
  );

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestFailed);
    } finally {
      setPending(false);
    }
  }

  return <article className={styles.teamCard}>
    <div className={styles.teamFields}>
      <label><span>{copy.teamName}</span><input value={name} disabled={!canManage || pending} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>{copy.teamDescription}</span><input value={description} disabled={!canManage || pending} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
      {canManage && <button type="button" disabled={pending || !name.trim() || (name === team.name && description === team.description)} onClick={() => void run(() => apiRequest(`/api/organizations/${organizationId}/teams/${team.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description }),
      }))}><Save size={14} /> {copy.save}</button>}
      {canManage && <button className={styles.dangerButton} type="button" disabled={pending} onClick={() => {
        if (!window.confirm(`${copy.deleteTeam}: ${team.name}?`)) return;
        void run(() => apiRequest(`/api/organizations/${organizationId}/teams/${team.id}`, { method: "DELETE" }));
      }}><Trash2 size={14} /> {copy.deleteTeam}</button>}
    </div>
    <div className={styles.teamMembers}>
      {team.members.map((member) => <span key={member.userId}>
        <UserAvatar className={styles.avatar} imageUrl={member.image} name={member.name} />
        <b>{member.name}</b>
        {canManage && <button type="button" aria-label={`${copy.removeMember}: ${member.name}`} disabled={pending} onClick={() => void run(() => apiRequest(`/api/organizations/${organizationId}/teams/${team.id}/members/${encodeURIComponent(member.userId)}`, { method: "DELETE" }))}><X size={12} /></button>}
      </span>)}
      {canManage && availableMembers.length > 0 && <div className={styles.inlineAdd}>
        <select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
          <option value="">{copy.chooseMember}</option>
          {availableMembers.map((member) => <option value={member.userId} key={member.userId}>{member.name} · {member.email}</option>)}
        </select>
        <button type="button" disabled={!memberId || pending} onClick={() => void run(async () => {
          await apiRequest(`/api/organizations/${organizationId}/teams/${team.id}/members/${encodeURIComponent(memberId)}`, { method: "PUT" });
          setMemberId("");
        })}><Plus size={13} /> {copy.addMember}</button>
      </div>}
    </div>
    {error && <div className={styles.error} role="alert">{error}</div>}
  </article>;
}

function WorkspaceAccessCard({
  organization,
  workspace,
  accessible,
  onChanged,
}: {
  organization: OrganizationView;
  workspace: OrganizationView["workspaces"][number];
  accessible: boolean;
  onChanged: () => void;
}) {
  const { locale } = useI18n();
  const copy = copyFor(locale);
  const [principalType, setPrincipalType] = useState<"member" | "team">("member");
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState<GrantRole>("viewer");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const direct = organization.workspaceMemberGrants.filter((item) => item.workspaceId === workspace.id);
  const teams = organization.workspaceGrants.filter((item) => item.workspaceId === workspace.id);
  const candidates = principalType === "member"
    ? organization.members.filter((member) => !direct.some((grant) => grant.userId === member.userId))
    : organization.teams.filter((team) => !teams.some((grant) => grant.teamId === team.id));

  async function mutate(method: "PUT" | "DELETE", body: Record<string, unknown>) {
    setPending(true);
    setError("");
    try {
      await apiRequest(`/api/organizations/${organization.organization.id}/workspace-grants`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setPrincipalId("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestFailed);
    } finally {
      setPending(false);
    }
  }

  return <article className={styles.workspaceCard}>
    <header>
      <div><Building2 size={18} /><span><strong>{workspace.name}</strong><small>{workspace.lifecycleState}</small></span></div>
      {accessible && workspace.lifecycleState === "active" && <Link href={`/app?workspace=${encodeURIComponent(workspace.id)}`}>{copy.openWorkspace}</Link>}
    </header>
    <div className={styles.grantColumns}>
      <section><h4>{copy.people}</h4>{direct.length === 0 ? <small>{copy.noDirectAccess}</small> : direct.map((grant) => <div className={styles.grantRow} key={grant.id}>
        <UserAvatar className={styles.avatar} imageUrl={grant.memberImage} name={grant.memberName} />
        <span><strong>{grant.memberName}</strong><small>{grant.memberEmail}</small></span>
        <select disabled={!organization.permissions.canManageWorkspaces || pending} value={grant.role} onChange={(event) => void mutate("PUT", { principalType: "member", principalId: grant.userId, workspaceId: workspace.id, role: event.target.value })}>
          <option value="viewer">{copy.viewer}</option><option value="editor">{copy.editor}</option><option value="admin">{copy.workspaceAdmin}</option>
        </select>
        {organization.permissions.canManageWorkspaces && <button type="button" title={copy.removeAccess} disabled={pending} onClick={() => void mutate("DELETE", { principalType: "member", principalId: grant.userId, workspaceId: workspace.id })}><X size={13} /></button>}
      </div>)}</section>
      <section><h4>{copy.teamAccess}</h4>{teams.length === 0 ? <small>{copy.noTeamAccess}</small> : teams.map((grant) => <div className={styles.grantRow} key={grant.id}>
        <span className={styles.teamIcon}><UsersRound size={15} /></span>
        <span><strong>{grant.teamName}</strong><small>{roleLabel(grant.role, locale)}</small></span>
        <select disabled={!organization.permissions.canManageWorkspaces || pending} value={grant.role} onChange={(event) => void mutate("PUT", { principalType: "team", principalId: grant.teamId, workspaceId: workspace.id, role: event.target.value })}>
          <option value="viewer">{copy.viewer}</option><option value="editor">{copy.editor}</option><option value="admin">{copy.workspaceAdmin}</option>
        </select>
        {organization.permissions.canManageWorkspaces && <button type="button" title={copy.removeAccess} disabled={pending} onClick={() => void mutate("DELETE", { principalType: "team", principalId: grant.teamId, workspaceId: workspace.id })}><X size={13} /></button>}
      </div>)}</section>
    </div>
    {organization.permissions.canManageWorkspaces && workspace.lifecycleState === "active" && <div className={styles.addGrant}>
      <strong>{copy.addAccess}</strong>
      <select value={principalType} onChange={(event) => { setPrincipalType(event.target.value as "member" | "team"); setPrincipalId(""); }}><option value="member">{copy.directPerson}</option><option value="team">{copy.team}</option></select>
      <select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}><option value="">{copy.choosePrincipal}</option>{candidates.map((candidate) => <option value={principalType === "member" ? (candidate as OrganizationMemberSummary).userId : (candidate as TeamSummary).id} key={principalType === "member" ? (candidate as OrganizationMemberSummary).userId : (candidate as TeamSummary).id}>{candidate.name}</option>)}</select>
      <select value={role} onChange={(event) => setRole(event.target.value as GrantRole)}><option value="viewer">{copy.viewer}</option><option value="editor">{copy.editor}</option><option value="admin">{copy.workspaceAdmin}</option></select>
      <button type="button" disabled={!principalId || pending} onClick={() => void mutate("PUT", { principalType, principalId, workspaceId: workspace.id, role })}><Plus size={13} /> {copy.addAccess}</button>
    </div>}
    {error && <div className={styles.error} role="alert">{error}</div>}
  </article>;
}

export function OrganizationSettingsPanel({
  initialView,
  agents,
  mcpUrl,
  uploadWorkspaceId,
  accessibleWorkspaces,
  currentUserId,
}: {
  initialView: OrganizationView;
  agents: AccountAgentSummary[];
  mcpUrl: string;
  uploadWorkspaceId: string;
  accessibleWorkspaces: WorkspaceSummary[];
  currentUserId: string;
}) {
  const { locale } = useI18n();
  const copy = copyFor(locale);
  const router = useRouter();
  const [name, setName] = useState(initialView.organization.name);
  const [icon, setIcon] = useState(initialView.organization.icon ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteUrl, setInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashConfirmation, setTrashConfirmation] = useState("");
  const organizationId = initialView.organization.id;
  const activeInvitations = initialView.invitations.filter((invitation) => invitation.status === "active");
  const accessibleIds = useMemo(() => new Set(accessibleWorkspaces.map((workspace) => workspace.id)), [accessibleWorkspaces]);

  async function run(action: () => Promise<unknown>, options: { clearSaved?: boolean } = {}) {
    setPending(true);
    setError("");
    if (options.clearSaved !== false) setSaved(false);
    try {
      await action();
      router.refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestFailed);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function saveGeneral(event: FormEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const submittedName = String(form.get("organizationName") ?? "").trim();
    const submittedIcon = String(form.get("organizationIcon") ?? "").trim();
    if (!submittedName) return;
    if (await run(() => apiRequest(`/api/organizations/${organizationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: submittedName, icon: submittedIcon || null }),
    }))) setSaved(true);
  }

  async function createInvitation(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const body = await apiRequest(`/api/organizations/${organizationId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() || null, role: inviteRole }),
      });
      if (typeof body.url !== "string") throw new Error(copy.requestFailed);
      setInviteUrl(body.url);
      setInviteEmail("");
      setCopied(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.requestFailed);
    } finally {
      setPending(false);
    }
  }

  return <>
    <section className={styles.card} id="organization-general">
      <div className={styles.heading}><span><Building2 size={18} /></span><div><h2>{copy.general}</h2><p>{copy.generalDescription}</p></div></div>
      <form className={styles.generalForm} onSubmit={saveGeneral}>
        <label className={styles.iconField}><span>{copy.icon}</span><input name="organizationIcon" value={icon} maxLength={16} disabled={!initialView.permissions.canUpdate || pending} onChange={(event) => setIcon(event.target.value)} /><small>{copy.iconHint}</small></label>
        <label><span>{copy.name}</span><input name="organizationName" value={name} maxLength={120} required disabled={!initialView.permissions.canUpdate || pending} onChange={(event) => setName(event.target.value)} /></label>
        {initialView.permissions.canUpdate && <button type="submit" disabled={pending || !name.trim()}><Save size={14} /> {pending ? copy.saving : copy.save}</button>}
      </form>
      {saved && <div className={styles.success}><Check size={14} /> {copy.saved}</div>}
    </section>

    <section className={styles.card} id="organization-members">
      <div className={styles.heading}><span><UsersRound size={18} /></span><div><h2>{copy.members}</h2><p>{copy.membersDescription}</p></div></div>
      {initialView.permissions.canManageMembers && <form className={styles.inviteForm} onSubmit={createInvitation}>
        <label><span>{copy.inviteEmail}</span><input type="email" value={inviteEmail} maxLength={254} onChange={(event) => setInviteEmail(event.target.value)} /></label>
        <label><span>{copy.inviteRole}</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "admin" | "member")}><option value="member">{copy.member}</option>{initialView.organization.role === "owner" && <option value="admin">{copy.admin}</option>}</select></label>
        <button type="submit" disabled={pending}><MailPlus size={14} /> {copy.invite}</button>
      </form>}
      {inviteUrl && <div className={styles.inviteSecret}><div><strong>{copy.inviteReady}</strong><small>{copy.inviteReadyHint}</small><code>{inviteUrl}</code></div><button type="button" onClick={async () => { await navigator.clipboard.writeText(inviteUrl); setCopied(true); }}><ClipboardCopy size={14} /> {copied ? copy.copied : copy.copy}</button></div>}
      <div className={styles.memberList}>{initialView.members.map((member) => <article key={member.id}>
        <UserAvatar className={styles.avatar} imageUrl={member.image} name={member.name} />
        <div><strong>{member.name}{member.userId === currentUserId ? ` · ${copy.currentUser}` : ""}</strong><small>{member.email}</small></div>
        <select value={member.role} disabled={initialView.organization.role !== "owner" || pending} onChange={(event) => void run(() => apiRequest(`/api/organizations/${organizationId}/members/${encodeURIComponent(member.userId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: event.target.value }) }))}><option value="member">{copy.member}</option><option value="admin">{copy.admin}</option><option value="owner">{copy.owner}</option></select>
        {initialView.permissions.canManageMembers && member.userId !== currentUserId && (initialView.organization.role === "owner" || member.role === "member") && <button type="button" title={copy.removeMember} disabled={pending} onClick={() => { if (window.confirm(`${copy.removeMember}: ${member.name}?`)) void run(() => apiRequest(`/api/organizations/${organizationId}/members/${encodeURIComponent(member.userId)}`, { method: "DELETE" })); }}><UserMinus size={15} /></button>}
      </article>)}</div>
      {initialView.permissions.canManageMembers && <div className={styles.invitationList}><h3>{copy.activeInvitations}</h3>{activeInvitations.length === 0 ? <small>{copy.noInvitations}</small> : activeInvitations.map((invitation) => <div key={invitation.id}><span><strong>{invitation.email ?? invitation.prefix + "…"}</strong><small suppressHydrationWarning>{roleLabel(invitation.role, locale)} · {dateLabel(invitation.expiresAt, locale)}</small></span><button type="button" disabled={pending} onClick={() => void run(() => apiRequest(`/api/organizations/${organizationId}/invitations/${invitation.id}`, { method: "DELETE" }))}>{copy.revoke}</button></div>)}</div>}
    </section>

    <section className={styles.card} id="organization-teams">
      <div className={styles.heading}><span><UsersRound size={18} /></span><div><h2>{copy.teams}</h2><p>{copy.teamsDescription}</p></div></div>
      {initialView.permissions.canManageTeams && <form className={styles.teamCreate} onSubmit={(event) => { event.preventDefault(); void run(async () => { await apiRequest(`/api/organizations/${organizationId}/teams`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: teamName, description: teamDescription }) }); setTeamName(""); setTeamDescription(""); }); }}><label><span>{copy.teamName}</span><input value={teamName} maxLength={80} onChange={(event) => setTeamName(event.target.value)} /></label><label><span>{copy.teamDescription}</span><input value={teamDescription} maxLength={500} onChange={(event) => setTeamDescription(event.target.value)} /></label><button type="submit" disabled={pending || !teamName.trim()}><Plus size={14} /> {copy.createTeam}</button></form>}
      <div className={styles.teamList}>{initialView.teams.length === 0 ? <div className={styles.empty}>{copy.noTeams}</div> : initialView.teams.map((team) => <TeamCard organizationId={organizationId} team={team} members={initialView.members} canManage={initialView.permissions.canManageTeams} onChanged={() => router.refresh()} key={`${team.id}:${team.updatedAt}:${team.members.length}`} />)}</div>
    </section>

    <section className={styles.card} id="organization-workspaces">
      <div className={styles.heading}><span><ShieldCheck size={18} /></span><div><h2>{copy.workspaces}</h2><p>{copy.workspacesDescription}</p></div>{initialView.permissions.canManageWorkspaces && <button type="button" onClick={() => setWorkspaceCreateOpen(true)}><Plus size={14} /> {copy.createWorkspace}</button>}</div>
      <div className={styles.workspaceList}>{initialView.workspaces.length === 0 ? <div className={styles.empty}>{copy.noWorkspaces}</div> : initialView.workspaces.map((workspace) => <WorkspaceAccessCard organization={initialView} workspace={workspace} accessible={accessibleIds.has(workspace.id)} onChanged={() => router.refresh()} key={`${workspace.id}:${workspace.updatedAt}:${initialView.workspaceGrants.length}:${initialView.workspaceMemberGrants.length}`} />)}</div>
    </section>

    <section id="organization-agents" className={styles.agentSection}>
      {initialView.permissions.canManageAgents ? <AccountAgentsPanel collectionEndpoint={`/api/organizations/${organizationId}/agents`} initialAgents={agents} mcpUrl={mcpUrl} uploadWorkspaceId={uploadWorkspaceId} workspaces={accessibleWorkspaces.filter((workspace) => workspace.owner.type === "organization" && workspace.owner.id === organizationId)} /> : <section className={styles.card}><div className={styles.heading}><span><UsersRound size={18} /></span><div><h2>{copy.agentsReadOnly}</h2><p>{copy.agentsReadOnlyHint}</p></div></div>{agents.length === 0 ? <div className={styles.empty}>{copy.noAgents}</div> : agents.map((agent) => <div className={styles.readOnlyAgent} key={agent.id}><UserAvatar className={styles.avatar} imageUrl={agent.avatarMediaId ? `/api/media/${agent.avatarMediaId}` : null} name={agent.displayName} /><strong>{agent.displayName}</strong></div>)}</section>}
    </section>

    {initialView.permissions.canReadAudit && <section className={styles.card} id="organization-audit"><div className={styles.heading}><span><History size={18} /></span><div><h2>{copy.audit}</h2><p>{copy.auditDescription}</p></div></div><div className={styles.auditList}>{initialView.auditEvents.length === 0 ? <div className={styles.empty}>{copy.noAudit}</div> : initialView.auditEvents.map((event) => <article key={event.id}><span data-outcome={event.outcome} /><div><strong>{event.action}</strong><small>{event.actorLabel} · {event.targetType}{event.targetId ? ` · ${event.targetId}` : ""}</small></div><time suppressHydrationWarning>{dateLabel(event.createdAt, locale)}</time></article>)}</div></section>}

    {initialView.permissions.canTrash && <section className={`${styles.card} ${styles.dangerCard}`} id="organization-danger"><div className={styles.heading}><span><Trash2 size={18} /></span><div><h2>{copy.danger}</h2><p>{copy.dangerDescription}</p></div></div><button className={styles.dangerButton} type="button" onClick={() => { setTrashConfirmation(""); setTrashOpen(true); }}><Trash2 size={14} /> {copy.trash}</button></section>}

    {error && <div className={styles.floatingError} role="alert">{error}</div>}
    {workspaceCreateOpen && <WorkspaceCreateDialog fixedOrganization={initialView.organization} onClose={() => setWorkspaceCreateOpen(false)} />}
    {trashOpen && <div className={styles.backdrop} role="presentation"><form className={styles.trashDialog} role="dialog" aria-modal="true" aria-labelledby="trash-organization-title" onSubmit={(event) => { event.preventDefault(); void run(async () => { await apiRequest(`/api/organizations/${organizationId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationName: trashConfirmation }) }); window.location.assign(`/settings/organization?workspace=${encodeURIComponent(uploadWorkspaceId)}`); }); }}><Trash2 size={22} /><h2 id="trash-organization-title">{copy.danger}</h2><p>{copy.dangerDescription}</p><label><span>{copy.confirmTrash}</span><strong>{initialView.organization.name}</strong><input autoFocus value={trashConfirmation} onChange={(event) => setTrashConfirmation(event.target.value)} /></label><footer><button type="button" disabled={pending} onClick={() => setTrashOpen(false)}>{copy.cancel}</button><button className={styles.dangerButton} type="submit" disabled={pending || trashConfirmation.trim() !== initialView.organization.name}><Trash2 size={14} /> {copy.trash}</button></footer></form></div>}
  </>;
}

export function OrganizationDirectory({
  trashedOrganizations,
  workspaceId,
}: {
  trashedOrganizations: OrganizationSummary[];
  workspaceId: string;
}) {
  const { locale } = useI18n();
  const copy = copyFor(locale);
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (trashedOrganizations.length === 0) return null;
  return <section className={`${styles.card} ${styles.dangerCard}`}><div className={styles.heading}><span><Trash2 size={18} /></span><div><h2>{copy.deletedOrganizations}</h2><p>{copy.deletedOrganizationsDescription}</p></div></div><div className={styles.deletedOrganizations}>{trashedOrganizations.map((organization) => <article key={organization.id}><span>{organization.icon || <Building2 size={17} />}</span><div><strong>{organization.name}</strong><small suppressHydrationWarning>{organization.purgeAfter ? dateLabel(organization.purgeAfter, locale) : ""}</small></div><button type="button" disabled={Boolean(pending)} onClick={async () => { setPending(organization.id); setError(""); try { await apiRequest(`/api/organizations/${organization.id}/restore`, { method: "POST" }); router.push(`/settings/organization?workspace=${encodeURIComponent(workspaceId)}&organization=${encodeURIComponent(organization.id)}`); router.refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : copy.requestFailed); } finally { setPending(null); } }}>{pending === organization.id ? copy.saving : copy.restore}</button></article>)}</div>{error && <div className={styles.error}>{error}</div>}</section>;
}

export function OrganizationCreateDialog({
  onClose,
  workspaceId,
}: {
  onClose: () => void;
  workspaceId: string;
}) {
  const { locale } = useI18n();
  const router = useRouter();
  const copy = {
    en: { title: "Create an organization", description: "Start a shared namespace for people, teams, workspaces, and organization-owned agents.", name: "Organization name", icon: "Icon (optional)", cancel: "Cancel", create: "Create organization", creating: "Creating…", failed: "Could not create the organization." },
    ko: { title: "새 조직 만들기", description: "사람·팀·워크스페이스·조직 에이전트를 함께 관리할 네임스페이스를 만듭니다.", name: "조직 이름", icon: "아이콘 (선택)", cancel: "취소", create: "조직 만들기", creating: "만드는 중…", failed: "조직을 만들지 못했습니다." },
    ja: { title: "組織を作成", description: "人、チーム、ワークスペース、組織エージェントを共有する名前空間を作成します。", name: "組織名", icon: "アイコン（任意）", cancel: "キャンセル", create: "組織を作成", creating: "作成中…", failed: "組織を作成できませんでした。" },
  }[locale];
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}><form className={styles.createDialog} onSubmit={async (event) => {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      const body = await apiRequest("/api/organizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, icon: icon.trim() || null }) });
      const organization = body.organization as OrganizationSummary | undefined;
      if (!organization) throw new Error(copy.failed);
      router.push(`/settings/organization?workspace=${encodeURIComponent(workspaceId)}&organization=${encodeURIComponent(organization.id)}`);
      router.refresh();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
      setPending(false);
    }
  }} role="dialog" aria-modal="true" aria-labelledby="create-organization-title"><header><span><Building2 size={20} /></span><div><p>NEW ORGANIZATION</p><h2 id="create-organization-title">{copy.title}</h2></div><button type="button" aria-label={copy.cancel} disabled={pending} onClick={onClose}><X size={18} /></button></header><p>{copy.description}</p><label><span>{copy.name}</span><input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label><label><span>{copy.icon}</span><input value={icon} maxLength={16} onChange={(event) => setIcon(event.target.value)} /></label>{error && <div className={styles.error} role="alert">{error}</div>}<footer><button type="button" disabled={pending} onClick={onClose}>{copy.cancel}</button><button type="submit" disabled={pending || !name.trim()}><Plus size={14} /> {pending ? copy.creating : copy.create}</button></footer></form></div>;
}
