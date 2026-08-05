import { createHash } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";

type TableColumn = {
  name: string;
  pk: number;
};

export type TableFingerprint = {
  columns: string[];
  primaryKey: string[];
  rowCount: number;
  sha256: string;
};

export type DatabaseFingerprint = {
  format: "nyxdoc-data-fingerprint/v1";
  tables: Record<string, TableFingerprint>;
};

export type DatabaseIntegrity = {
  integrityCheck: "ok";
  foreignKeyViolations: 0;
  tenantBoundaryViolations: 0;
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function listDataTables(database: NyxDatabase) {
  return (database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_nyxdoc_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>).map((row) => row.name);
}

function tableColumns(database: NyxDatabase, table: string): TableColumn[] {
  return (database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as Array<{ name: string; pk: number }>).map((column) => ({
    name: column.name,
    pk: Number(column.pk),
  }));
}

function tableExists(database: NyxDatabase, table: string) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function tableHasColumns(database: NyxDatabase, table: string, columns: string[]) {
  if (!tableExists(database, table)) return false;
  const names = new Set(tableColumns(database, table).map((column) => column.name));
  return columns.every((column) => names.has(column));
}

function tenantBoundaryViolations(database: NyxDatabase) {
  const checks: Array<{
    name: string;
    requirements: Array<[string, string[]]>;
    sql: string;
  }> = [
    {
      name: "document_parent",
      requirements: [["documents", ["id", "workspace_id", "parent_document_id"]]],
      sql: `SELECT COUNT(*) AS count
            FROM documents child
            LEFT JOIN documents parent ON parent.id = child.parent_document_id
            WHERE child.parent_document_id IS NOT NULL
              AND (parent.id IS NULL OR parent.workspace_id <> child.workspace_id)`,
    },
    {
      name: "document_event",
      requirements: [
        ["documents", ["id", "workspace_id"]],
        ["document_events", ["document_id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_events event
            LEFT JOIN documents document ON document.id = event.document_id
            WHERE document.id IS NULL OR document.workspace_id <> event.workspace_id`,
    },
    {
      name: "document_reference",
      requirements: [
        ["documents", ["id", "workspace_id"]],
        ["document_references", ["source_document_id", "target_document_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_references reference
            LEFT JOIN documents source ON source.id = reference.source_document_id
            LEFT JOIN documents target ON target.id = reference.target_document_id
            WHERE source.id IS NULL OR target.id IS NULL OR source.workspace_id <> target.workspace_id`,
    },
    {
      name: "agent_avatar",
      requirements: [
        ["workspace_agents", ["workspace_id", "avatar_media_id"]],
        ["media_assets", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_agents agent
            LEFT JOIN media_assets media ON media.id = agent.avatar_media_id
            WHERE agent.avatar_media_id IS NOT NULL
              AND (media.id IS NULL OR media.workspace_id <> agent.workspace_id)`,
    },
    {
      name: "credential_agent",
      requirements: [
        ["workspace_api_tokens", ["workspace_id", "agent_id"]],
        ["workspace_agents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_api_tokens token
            LEFT JOIN workspace_agents agent ON agent.id = token.agent_id
            WHERE token.agent_id IS NOT NULL
              AND (agent.id IS NULL OR agent.workspace_id <> token.workspace_id)`,
    },
    {
      name: "credential_root",
      requirements: [
        ["workspace_api_tokens", ["workspace_id", "root_document_id"]],
        ["documents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_api_tokens token
            LEFT JOIN documents document ON document.id = token.root_document_id
            WHERE token.root_document_id IS NOT NULL
              AND (document.id IS NULL OR document.workspace_id <> token.workspace_id)`,
    },
    {
      name: "media_credential",
      requirements: [
        ["media_assets", ["workspace_id", "uploaded_by_token_id"]],
        ["workspace_api_tokens", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM media_assets media
            LEFT JOIN workspace_api_tokens token ON token.id = media.uploaded_by_token_id
            WHERE media.uploaded_by_token_id IS NOT NULL
              AND (token.id IS NULL OR token.workspace_id <> media.workspace_id)`,
    },
    {
      name: "agent_assignment",
      requirements: [
        ["agent_document_assignments", ["workspace_id", "agent_id", "document_id", "assigned_by_agent_id"]],
        ["workspace_agents", ["id", "workspace_id"]],
        ["documents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM agent_document_assignments assignment
            LEFT JOIN workspace_agents agent ON agent.id = assignment.agent_id
            LEFT JOIN documents document ON document.id = assignment.document_id
            LEFT JOIN workspace_agents actor ON actor.id = assignment.assigned_by_agent_id
            WHERE agent.id IS NULL OR document.id IS NULL
              OR agent.workspace_id <> assignment.workspace_id
              OR document.workspace_id <> assignment.workspace_id
              OR (assignment.assigned_by_agent_id IS NOT NULL
                  AND (actor.id IS NULL OR actor.workspace_id <> assignment.workspace_id))`,
    },
    {
      name: "saved_view_agent",
      requirements: [
        ["workspace_saved_views", ["workspace_id", "created_by_agent_id"]],
        ["workspace_agents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_saved_views view
            LEFT JOIN workspace_agents agent ON agent.id = view.created_by_agent_id
            WHERE view.created_by_agent_id IS NOT NULL
              AND (agent.id IS NULL OR agent.workspace_id <> view.workspace_id)`,
    },
    {
      name: "admin_request_agent",
      requirements: [
        ["workspace_admin_action_requests", ["workspace_id", "requested_by_agent_id"]],
        ["workspace_agents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_admin_action_requests request
            LEFT JOIN workspace_agents agent ON agent.id = request.requested_by_agent_id
            WHERE request.requested_by_agent_id IS NOT NULL
              AND (agent.id IS NULL OR agent.workspace_id <> request.workspace_id)`,
    },
    {
      name: "collaboration_state",
      requirements: [
        ["document_collaboration_states", ["workspace_id", "document_id"]],
        ["documents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_collaboration_states state
            LEFT JOIN documents document ON document.id = state.document_id
            WHERE document.id IS NULL OR document.workspace_id <> state.workspace_id`,
    },
    {
      name: "document_public_share",
      requirements: [
        ["document_public_shares", ["workspace_id", "document_id"]],
        ["documents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_public_shares share
            LEFT JOIN documents document ON document.id = share.document_id
            WHERE document.id IS NULL OR document.workspace_id <> share.workspace_id`,
    },
    {
      name: "document_human_grant",
      requirements: [
        ["document_human_grants", ["workspace_id", "document_id"]],
        ["documents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_human_grants grant_entry
            LEFT JOIN documents document ON document.id = grant_entry.document_id
            WHERE document.id IS NULL OR document.workspace_id <> grant_entry.workspace_id`,
    },
    {
      name: "document_media_binding",
      requirements: [
        ["document_media_bindings", ["workspace_id", "document_id", "media_id"]],
        ["documents", ["id", "workspace_id"]],
        ["media_assets", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_media_bindings binding
            LEFT JOIN documents document ON document.id = binding.document_id
            LEFT JOIN media_assets media ON media.id = binding.media_id
            WHERE document.id IS NULL OR media.id IS NULL
              OR document.workspace_id <> binding.workspace_id
              OR media.workspace_id <> binding.workspace_id`,
    },
    {
      name: "document_task_attachment",
      requirements: [
        ["document_task_attachments", ["workspace_id", "task_id", "media_id"]],
        ["document_tasks", ["id", "workspace_id"]],
        ["media_assets", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_task_attachments attachment
            LEFT JOIN document_tasks task ON task.id = attachment.task_id
            LEFT JOIN media_assets media ON media.id = attachment.media_id
            WHERE task.id IS NULL OR media.id IS NULL
              OR task.workspace_id <> attachment.workspace_id
              OR media.workspace_id <> attachment.workspace_id`,
    },
    {
      name: "workspace_namespace_owner",
      requirements: [
        ["workspaces", ["id"]],
        ["workspace_ownership", ["workspace_id", "owner_type", "owner_user_id", "organization_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspaces workspace
            LEFT JOIN workspace_ownership ownership
              ON ownership.workspace_id = workspace.id
            WHERE ownership.workspace_id IS NULL
              OR (ownership.owner_type = 'personal'
                  AND (ownership.owner_user_id IS NULL OR ownership.organization_id IS NOT NULL))
              OR (ownership.owner_type = 'organization'
                  AND (ownership.organization_id IS NULL OR ownership.owner_user_id IS NOT NULL))`,
    },
    {
      name: "agent_namespace_owner",
      requirements: [
        ["agents", ["id"]],
        ["agent_ownership", ["agent_id", "owner_type", "owner_user_id", "organization_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM agents agent
            LEFT JOIN agent_ownership ownership ON ownership.agent_id = agent.id
            WHERE ownership.agent_id IS NULL
              OR (ownership.owner_type = 'personal'
                  AND (ownership.owner_user_id IS NULL OR ownership.organization_id IS NOT NULL))
              OR (ownership.owner_type = 'organization'
                  AND (ownership.organization_id IS NULL OR ownership.owner_user_id IS NOT NULL))`,
    },
    {
      name: "team_member_organization",
      requirements: [
        ["teams", ["id", "organization_id"]],
        ["team_members", ["team_id", "organization_id", "user_id"]],
        ["organization_members", ["organization_id", "user_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM team_members team_member
            LEFT JOIN teams team ON team.id = team_member.team_id
            LEFT JOIN organization_members organization_member
              ON organization_member.organization_id = team_member.organization_id
             AND organization_member.user_id = team_member.user_id
            WHERE team.id IS NULL
               OR team.organization_id <> team_member.organization_id
               OR organization_member.id IS NULL`,
    },
    {
      name: "workspace_team_grant_organization",
      requirements: [
        ["workspace_team_grants", ["organization_id", "workspace_id", "team_id"]],
        ["workspace_ownership", ["workspace_id", "owner_type", "organization_id"]],
        ["teams", ["id", "organization_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_team_grants grant_entry
            LEFT JOIN workspace_ownership ownership
              ON ownership.workspace_id = grant_entry.workspace_id
            LEFT JOIN teams team ON team.id = grant_entry.team_id
            WHERE ownership.workspace_id IS NULL
               OR ownership.owner_type <> 'organization'
               OR ownership.organization_id <> grant_entry.organization_id
               OR team.id IS NULL
               OR team.organization_id <> grant_entry.organization_id`,
    },
    {
      name: "workspace_member_organization",
      requirements: [
        ["workspace_members", ["workspace_id", "user_id"]],
        ["workspace_ownership", ["workspace_id", "owner_type", "organization_id"]],
        ["organization_members", ["organization_id", "user_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_members workspace_member
            JOIN workspace_ownership ownership
              ON ownership.workspace_id = workspace_member.workspace_id
             AND ownership.owner_type = 'organization'
            LEFT JOIN organization_members organization_member
              ON organization_member.organization_id = ownership.organization_id
             AND organization_member.user_id = workspace_member.user_id
            WHERE organization_member.id IS NULL`,
    },
    {
      name: "document_human_grant_organization",
      requirements: [
        ["document_human_grants", ["workspace_id", "user_id"]],
        ["workspace_ownership", ["workspace_id", "owner_type", "organization_id"]],
        ["organization_members", ["organization_id", "user_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM document_human_grants document_grant
            JOIN workspace_ownership ownership
              ON ownership.workspace_id = document_grant.workspace_id
             AND ownership.owner_type = 'organization'
            LEFT JOIN organization_members organization_member
              ON organization_member.organization_id = ownership.organization_id
             AND organization_member.user_id = document_grant.user_id
            WHERE organization_member.id IS NULL`,
    },
    {
      name: "app_bug_report_document",
      requirements: [
        ["app_bug_reports", ["workspace_id", "document_id"]],
        ["documents", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM app_bug_reports report
            LEFT JOIN documents document ON document.id = report.document_id
            WHERE report.document_id IS NOT NULL
              AND (document.id IS NULL OR document.workspace_id <> report.workspace_id)`,
    },
    {
      name: "app_bug_report_attachment",
      requirements: [
        ["app_bug_report_attachments", ["bug_report_id", "workspace_id", "media_id"]],
        ["app_bug_reports", ["id", "workspace_id", "trigger"]],
        ["media_assets", ["id", "workspace_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM app_bug_report_attachments attachment
            LEFT JOIN app_bug_reports report ON report.id = attachment.bug_report_id
            LEFT JOIN media_assets media ON media.id = attachment.media_id
            WHERE report.id IS NULL OR media.id IS NULL
              OR report.workspace_id <> attachment.workspace_id
              OR media.workspace_id <> attachment.workspace_id
              OR report.trigger <> 'manual'`,
    },
    {
      name: "organization_personal_agent_approval",
      requirements: [
        ["organization_agent_approvals", ["organization_id", "agent_id"]],
        ["agent_ownership", ["agent_id", "owner_type", "owner_user_id"]],
        ["organization_members", ["organization_id", "user_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM organization_agent_approvals approval
            LEFT JOIN agent_ownership ownership ON ownership.agent_id = approval.agent_id
            LEFT JOIN organization_members organization_member
              ON organization_member.organization_id = approval.organization_id
             AND organization_member.user_id = ownership.owner_user_id
            WHERE ownership.agent_id IS NULL
               OR ownership.owner_type <> 'personal'
               OR organization_member.id IS NULL`,
    },
    {
      name: "workspace_agent_namespace",
      requirements: [
        ["workspace_agents", ["workspace_id", "agent_identity_id"]],
        ["workspace_ownership", ["workspace_id", "owner_type", "owner_user_id", "organization_id"]],
        ["agent_ownership", ["agent_id", "owner_type", "owner_user_id", "organization_id"]],
        ["organization_agent_approvals", ["organization_id", "agent_id", "revoked_at"]],
        ["organization_members", ["organization_id", "user_id"]],
      ],
      sql: `SELECT COUNT(*) AS count
            FROM workspace_agents membership
            LEFT JOIN workspace_ownership workspace_owner
              ON workspace_owner.workspace_id = membership.workspace_id
            LEFT JOIN agent_ownership agent_owner
              ON agent_owner.agent_id = membership.agent_identity_id
            WHERE workspace_owner.workspace_id IS NULL
               OR agent_owner.agent_id IS NULL
               OR NOT (
                 (workspace_owner.owner_type = 'personal'
                  AND agent_owner.owner_type = 'personal'
                  AND workspace_owner.owner_user_id = agent_owner.owner_user_id)
                 OR
                 (workspace_owner.owner_type = 'organization' AND (
                   (agent_owner.owner_type = 'organization'
                    AND workspace_owner.organization_id = agent_owner.organization_id)
                   OR
                   (agent_owner.owner_type = 'personal'
                    AND EXISTS (
                      SELECT 1 FROM organization_agent_approvals approval
                      JOIN organization_members organization_member
                        ON organization_member.organization_id = approval.organization_id
                       AND organization_member.user_id = agent_owner.owner_user_id
                      WHERE approval.organization_id = workspace_owner.organization_id
                        AND approval.agent_id = agent_owner.agent_id
                        AND approval.revoked_at IS NULL
                    ))
                 ))
               )`,
    },
  ];

  return checks.flatMap((check) => {
    if (!check.requirements.every(([table, columns]) => tableHasColumns(database, table, columns))) {
      return [];
    }
    const row = database.prepare(check.sql).get() as { count: number };
    return Number(row.count) > 0 ? [{ name: check.name, count: Number(row.count) }] : [];
  });
}

function stableValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { type: "buffer", base64: value.toString("base64") };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value === undefined) return { type: "undefined" };
  return value;
}

function fingerprintTable(
  database: NyxDatabase,
  table: string,
  expected?: Pick<TableFingerprint, "columns" | "primaryKey">,
): TableFingerprint {
  const actualColumns = tableColumns(database, table);
  if (actualColumns.length === 0) throw new Error(`Table ${table} is missing or has no columns.`);

  const actualNames = new Set(actualColumns.map((column) => column.name));
  const columns = expected?.columns ?? actualColumns.map((column) => column.name);
  for (const column of columns) {
    if (!actualNames.has(column)) throw new Error(`Table ${table} lost column ${column}.`);
  }

  const primaryKey = expected?.primaryKey
    ?? actualColumns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
  const orderBy = primaryKey.length > 0 ? primaryKey : columns;
  const select = columns.map(quoteIdentifier).join(", ");
  const order = orderBy.map(quoteIdentifier).join(", ");
  const statement = database.prepare(
    `SELECT ${select} FROM ${quoteIdentifier(table)} ORDER BY ${order}`,
  );
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ table, columns, primaryKey }));
  hash.update("\n");
  let rowCount = 0;
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    hash.update(JSON.stringify(columns.map((column) => stableValue(row[column]))));
    hash.update("\n");
    rowCount += 1;
  }

  return {
    columns,
    primaryKey,
    rowCount,
    sha256: hash.digest("hex"),
  };
}

export function captureDatabaseFingerprint(
  database: NyxDatabase,
  baseline?: DatabaseFingerprint,
): DatabaseFingerprint {
  const tables: Record<string, TableFingerprint> = {};
  const names = baseline ? Object.keys(baseline.tables).sort() : listDataTables(database);
  for (const table of names) {
    tables[table] = fingerprintTable(database, table, baseline?.tables[table]);
  }
  return { format: "nyxdoc-data-fingerprint/v1", tables };
}

export function assertDatabaseFingerprintEqual(
  before: DatabaseFingerprint,
  after: DatabaseFingerprint,
) {
  for (const [table, expected] of Object.entries(before.tables)) {
    const actual = after.tables[table];
    if (!actual) throw new Error(`Table ${table} disappeared during migration.`);
    if (actual.rowCount !== expected.rowCount || actual.sha256 !== expected.sha256) {
      throw new Error(
        `Table ${table} changed during a data-preserving migration `
        + `(rows ${expected.rowCount} -> ${actual.rowCount}, `
        + `sha256 ${expected.sha256} -> ${actual.sha256}).`,
      );
    }
  }
}

export function assertDatabaseIntegrity(database: NyxDatabase): DatabaseIntegrity {
  const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrityRows)}`);
  }
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length > 0) {
    throw new Error(`SQLite foreign_key_check failed with ${foreignKeyRows.length} violation(s).`);
  }
  const boundaryRows = tenantBoundaryViolations(database);
  if (boundaryRows.length > 0) {
    throw new Error(`Workspace boundary integrity failed: ${JSON.stringify(boundaryRows)}.`);
  }
  return {
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    tenantBoundaryViolations: 0,
  };
}

export function captureTableInventory(database: NyxDatabase) {
  const inventory: Record<string, number> = {};
  for (const table of (database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>).map((row) => row.name)) {
    const result = database
      .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
      .get() as { count: number };
    inventory[table] = Number(result.count);
  }
  return inventory;
}
