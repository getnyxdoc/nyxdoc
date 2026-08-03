import { randomUUID } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import { parseNyxdocDocumentV2, type NyxdocTextBlock } from "@/lib/editor/schema";
import { createDocument } from "@/lib/documents/service";
import type { AppLocale } from "@/lib/i18n/locales";

type BootstrapUser = {
  id: string;
  name: string;
  email: string;
};

type SeedBlock = {
  type: NyxdocTextBlock["type"];
  content: string;
  listStyleType?: NyxdocTextBlock["listStyleType"];
};

type SeedDocument = {
  title: string;
  slug: string;
  blocks: SeedBlock[];
};

type WorkspaceStarterContent = {
  workspaceName: (name: string) => string;
  document: SeedDocument;
  revisionSummary: string;
};

export function workspaceStarterContent(locale: AppLocale): WorkspaceStarterContent {
  const content: Record<AppLocale, WorkspaceStarterContent> = {
    en: {
      workspaceName: (name) => `${name}'s workspace`,
      document: {
        title: "Getting started",
        slug: "getting-started",
        blocks: [
          { type: "h1", content: "Welcome to Nyxdoc" },
          { type: "p", content: "Write here directly, or ask your external agent to read and update this document through MCP." },
          { type: "callout", content: "Drafts are shared continuously. A canonical revision is created only when a person or agent explicitly saves." },
        ],
      },
      revisionSummary: "Created the first workspace document",
    },
    ko: {
      workspaceName: (name) => `${name}의 워크스페이스`,
      document: {
        title: "시작하기",
        slug: "getting-started",
        blocks: [
          { type: "h1", content: "Nyxdoc에 오신 것을 환영합니다" },
          { type: "p", content: "직접 문서를 작성하거나, 평소 사용하는 외부 에이전트에게 MCP로 이 문서를 읽고 수정해달라고 요청하세요." },
          { type: "callout", content: "초안은 계속 공유되지만, 사람이나 에이전트가 명시적으로 저장할 때만 정본 리비전이 만들어집니다." },
        ],
      },
      revisionSummary: "워크스페이스 첫 문서 생성",
    },
    ja: {
      workspaceName: (name) => `${name}のワークスペース`,
      document: {
        title: "はじめに",
        slug: "getting-started",
        blocks: [
          { type: "h1", content: "Nyxdocへようこそ" },
          { type: "p", content: "ここで直接文書を書くか、普段使っている外部エージェントにMCP経由でこの文書の読み書きを依頼してください。" },
          { type: "callout", content: "下書きは継続的に共有されますが、正本リビジョンは人またはエージェントが明示的に保存したときだけ作成されます。" },
        ],
      },
      revisionSummary: "ワークスペースの最初の文書を作成",
    },
  };
  return content[locale];
}

function slugSuffix(userId: string) {
  return userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase() || randomUUID().slice(0, 12);
}

export function ensurePersonalWorkspace(
  database: NyxDatabase,
  user: BootstrapUser,
  locale: AppLocale = "en",
) {
  const hasWorkspaceOwnership = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_ownership'",
  ).get());
  const hasLifecycleState = (database.prepare("PRAGMA table_info(workspaces)").all() as Array<{
    name: string;
  }>).some((column) => column.name === "lifecycle_state");
  const activeWorkspaceCondition = hasLifecycleState
    ? " AND w.lifecycle_state = 'active'"
    : "";
  const ownershipJoin = hasWorkspaceOwnership
    ? " JOIN workspace_ownership ownership ON ownership.workspace_id = w.id"
    : "";
  const personalOwnershipCondition = hasWorkspaceOwnership
    ? " AND ownership.owner_type = 'personal' AND ownership.owner_user_id = wm.user_id"
    : "";
  const existing = database
    .prepare(
      `SELECT w.id, w.name, w.slug
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       ${ownershipJoin}
       WHERE wm.user_id = ?${activeWorkspaceCondition}${personalOwnershipCondition}
       ORDER BY wm.created_at ASC
       LIMIT 1`,
    )
    .get(user.id) as { id: string; name: string; slug: string } | undefined;

  if (existing) return existing;

  return database.transaction(() => {
    const raced = database
      .prepare(
        `SELECT w.id, w.name, w.slug
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         ${ownershipJoin}
         WHERE wm.user_id = ?${activeWorkspaceCondition}${personalOwnershipCondition}
         LIMIT 1`,
      )
      .get(user.id) as { id: string; name: string; slug: string } | undefined;
    if (raced) return raced;

    const now = new Date().toISOString();
    const starter = workspaceStarterContent(locale);
    const workspace = {
      id: randomUUID(),
      name: starter.workspaceName(user.name || user.email.split("@")[0]),
      slug: `personal-${slugSuffix(user.id)}`,
    };

    database
      .prepare(
        `INSERT INTO workspaces (id, name, slug, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(workspace.id, workspace.name, workspace.slug, user.id, now, now);
    const hasAccessRole = (database.prepare("PRAGMA table_info(workspace_members)").all() as Array<{
      name: string;
    }>).some((column) => column.name === "access_role");
    database.prepare(hasAccessRole
      ? `INSERT INTO workspace_members (id, workspace_id, user_id, role, access_role, created_at)
         VALUES (?, ?, ?, 'owner', 'owner', ?)`
      : `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'owner', ?)`)
      .run(randomUUID(), workspace.id, user.id, now);
    if (hasWorkspaceOwnership) {
      database.prepare(
        `INSERT INTO workspace_ownership
         (workspace_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
         VALUES (?, 'personal', ?, NULL, ?, ?)`,
      ).run(workspace.id, user.id, now, now);
    }

    for (const document of [starter.document]) {
      const content = parseNyxdocDocumentV2({
        schemaVersion: 2,
        blocks: document.blocks.map((block) => ({
          id: randomUUID(),
          type: block.type,
          ...(block.listStyleType ? { listStyleType: block.listStyleType, indent: 1 } : {}),
          children: [{ text: block.content }],
        })),
      });
      const created = createDocument(
        database,
        workspace.id,
        {
          type: "system",
          userId: user.id,
          principalId: user.id,
          label: "Nyxdoc",
          source: "seed",
        },
        {
          title: document.title,
          content,
          summary: starter.revisionSummary,
        },
      );
      // The localized starter keeps a stable URL slug, while the document,
      // revision snapshot and event are still created by the canonical writer.
      database.prepare("UPDATE documents SET slug = ? WHERE id = ?")
        .run(document.slug, created.document.id);
    }

    return workspace;
  })();
}
