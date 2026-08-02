import { randomBytes, randomUUID } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import type { EditorCaretIncidentRequest } from "@/lib/editor/diagnostics";

const INCIDENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

type IncidentRow = {
  id: string;
  incidentCode: string;
  trigger: EditorCaretIncidentRequest["trigger"];
  reason: EditorCaretIncidentRequest["reason"];
  createdAt: string;
  expiresAt: string;
};

export type EditorCaretIncident = IncidentRow & {
  workspaceId: string;
  documentId: string;
  userId: string;
  clientIncidentId: string;
  mountCount: number;
  environment: EditorCaretIncidentRequest["environment"];
  trace: EditorCaretIncidentRequest["trace"];
};

function incidentCode(now: Date) {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `CAR-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function existingIncident(
  database: NyxDatabase,
  userId: string,
  clientIncidentId: string,
) {
  return database.prepare(
    `SELECT id, incident_code AS incidentCode, trigger, reason,
            created_at AS createdAt, expires_at AS expiresAt
     FROM editor_caret_incidents
     WHERE user_id = ? AND client_incident_id = ?`,
  ).get(userId, clientIncidentId) as IncidentRow | undefined;
}

export function createEditorCaretIncident(
  database: NyxDatabase,
  userId: string,
  input: EditorCaretIncidentRequest,
  now = new Date(),
) {
  const replay = existingIncident(database, userId, input.clientIncidentId);
  if (replay) return replay;

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INCIDENT_RETENTION_MS).toISOString();
  database.prepare("DELETE FROM editor_caret_incidents WHERE expires_at <= ?").run(createdAt);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomUUID();
    const code = incidentCode(now);
    try {
      database.prepare(
        `INSERT INTO editor_caret_incidents
         (id, incident_code, client_incident_id, workspace_id, document_id, user_id,
          trigger, reason, mount_count, environment_json, trace_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        code,
        input.clientIncidentId,
        input.workspaceId,
        input.documentId,
        userId,
        input.trigger,
        input.reason,
        input.mountCount,
        JSON.stringify(input.environment),
        JSON.stringify(input.trace),
        createdAt,
        expiresAt,
      );
      return {
        id,
        incidentCode: code,
        trigger: input.trigger,
        reason: input.reason,
        createdAt,
        expiresAt,
      } satisfies IncidentRow;
    } catch (error) {
      const concurrentReplay = existingIncident(database, userId, input.clientIncidentId);
      if (concurrentReplay) return concurrentReplay;
      if (attempt === 4) throw error;
    }
  }
  throw new Error("캐럿 진단 사건 번호를 만들지 못했습니다.");
}

export function getEditorCaretIncidentByCode(
  database: NyxDatabase,
  incidentCodeValue: string,
  now = new Date(),
): EditorCaretIncident | null {
  const row = database.prepare(
    `SELECT id, incident_code AS incidentCode, client_incident_id AS clientIncidentId,
            workspace_id AS workspaceId, document_id AS documentId, user_id AS userId,
            trigger, reason, mount_count AS mountCount,
            environment_json AS environmentJson, trace_json AS traceJson,
            created_at AS createdAt, expires_at AS expiresAt
     FROM editor_caret_incidents
     WHERE incident_code = ? AND expires_at > ?`,
  ).get(incidentCodeValue, now.toISOString()) as (IncidentRow & {
    clientIncidentId: string;
    workspaceId: string;
    documentId: string;
    userId: string;
    mountCount: number;
    environmentJson: string;
    traceJson: string;
  }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    incidentCode: row.incidentCode,
    clientIncidentId: row.clientIncidentId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    userId: row.userId,
    trigger: row.trigger,
    reason: row.reason,
    mountCount: row.mountCount,
    environment: JSON.parse(row.environmentJson) as EditorCaretIncidentRequest["environment"],
    trace: JSON.parse(row.traceJson) as EditorCaretIncidentRequest["trace"],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
