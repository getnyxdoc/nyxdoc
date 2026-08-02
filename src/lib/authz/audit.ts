import type { NyxDatabase } from "@/lib/db/client";

export type WorkspaceAuditEvent = {
  cursor: number;
  id: string;
  action: string;
  outcome: "succeeded" | "denied" | "failed";
  actorType: "system" | "human" | "agent";
  actorUserId: string | null;
  actorAgentId: string | null;
  actorLabel: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export function listWorkspaceAuditEvents(
  database: NyxDatabase,
  workspaceId: string,
  query: {
    beforeCursor?: number;
    actionPrefix?: string;
    actorType?: WorkspaceAuditEvent["actorType"];
    limit?: number;
  } = {},
) {
  const conditions = ["workspace_id = ?"];
  const values: unknown[] = [workspaceId];
  if (query.beforeCursor !== undefined) {
    conditions.push("cursor < ?");
    values.push(query.beforeCursor);
  }
  if (query.actionPrefix?.trim()) {
    conditions.push("action LIKE ? ESCAPE '\\'");
    const escaped = query.actionPrefix.trim().replace(/[\\%_]/g, "\\$&");
    values.push(`${escaped}%`);
  }
  if (query.actorType) {
    conditions.push("actor_type = ?");
    values.push(query.actorType);
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
  values.push(limit + 1);
  const rows = database.prepare(
    `SELECT cursor, id, action, outcome, actor_type, actor_user_id, actor_agent_id,
            actor_label, target_type, target_id, metadata_json, created_at
     FROM workspace_audit_events
     WHERE ${conditions.join(" AND ")}
     ORDER BY cursor DESC
     LIMIT ?`,
  ).all(...values) as Array<{
    cursor: number;
    id: string;
    action: string;
    outcome: WorkspaceAuditEvent["outcome"];
    actor_type: WorkspaceAuditEvent["actorType"];
    actor_user_id: string | null;
    actor_agent_id: string | null;
    actor_label: string;
    target_type: string;
    target_id: string | null;
    metadata_json: string;
    created_at: string;
  }>;
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map((row): WorkspaceAuditEvent => {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = { unreadable: true };
    }
    return {
      cursor: Number(row.cursor),
      id: row.id,
      action: row.action,
      outcome: row.outcome,
      actorType: row.actor_type,
      actorUserId: row.actor_user_id,
      actorAgentId: row.actor_agent_id,
      actorLabel: row.actor_label,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata,
      createdAt: row.created_at,
    };
  });
  return {
    events,
    nextBeforeCursor: hasMore ? events.at(-1)?.cursor ?? null : null,
    hasMore,
  };
}
