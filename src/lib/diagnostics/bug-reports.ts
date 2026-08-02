import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import type { AppBugReportRequest } from "@/lib/diagnostics/schema";
import packageJson from "../../../package.json";

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 90;
const MAX_PAYLOAD_BYTES = 256 * 1_024;
const MANUAL_TEN_MINUTE_LIMIT = 5;
const MANUAL_DAILY_LIMIT = 30;
const AUTOMATIC_HOURLY_FINGERPRINT_LIMIT = 20;
const AUTOMATIC_DEDUPE_MS = 15 * 60 * 1_000;

type BugReportRow = {
  id: string;
  reportCode: string;
  trigger: AppBugReportRequest["trigger"];
  category: AppBugReportRequest["category"];
  categorySource: AppBugReportRequest["categorySource"];
  detector: AppBugReportRequest["detector"] | null;
  reasonCode: AppBugReportRequest["reasonCode"];
  capturedAt: string;
  createdAt: string;
  expiresAt: string;
  occurrenceCount: number;
  deduplicated?: boolean;
};

export type AppBugReport = BugReportRow & {
  workspaceId: string;
  documentId: string | null;
  reporterUserId: string | null;
  clientReportId: string;
  description: string | null;
  appVersion: string;
  sourceRevision: string;
  payload: Omit<
    AppBugReportRequest,
    | "category"
    | "categorySource"
    | "capturedAt"
    | "description"
    | "detector"
    | "documentId"
    | "reasonCode"
    | "trigger"
  >;
  firstSeenAt: string;
  lastSeenAt: string;
};

export class BugReportError extends Error {
  constructor(
    readonly code: "RATE_LIMITED" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "BugReportError";
  }
}

function retentionDays() {
  const configured = Number(process.env.NYXDOC_DIAGNOSTIC_RETENTION_DAYS);
  if (!Number.isInteger(configured)) return DEFAULT_RETENTION_DAYS;
  return Math.max(1, Math.min(MAX_RETENTION_DAYS, configured));
}

function reportCode(now: Date) {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `BUG-${date}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function existingReport(
  database: NyxDatabase,
  workspaceId: string,
  reporterUserId: string,
  clientReportId: string,
) {
  return database.prepare(
    `SELECT id, report_code AS reportCode, trigger, category,
            category_source AS categorySource, detector, reason_code AS reasonCode,
            captured_at AS capturedAt, created_at AS createdAt, expires_at AS expiresAt,
            occurrence_count AS occurrenceCount
     FROM app_bug_reports
     WHERE workspace_id = ? AND reporter_user_id = ? AND client_report_id = ?`,
  ).get(workspaceId, reporterUserId, clientReportId) as BugReportRow | undefined;
}

function automaticFingerprint(input: {
  workspaceId: string;
  documentId: string | null;
  report: AppBugReportRequest;
  sourceRevision: string;
}) {
  return createHash("sha256").update(JSON.stringify([
    input.sourceRevision,
    input.workspaceId,
    input.documentId,
    input.report.detector,
    input.report.snapshot.editorMode,
    input.report.snapshot.syncState,
    input.report.snapshot.blockCount,
  ])).digest("hex");
}

function countReports(
  database: NyxDatabase,
  reporterUserId: string,
  trigger: AppBugReportRequest["trigger"],
  since: string,
) {
  return Number((database.prepare(
    `SELECT COUNT(*) AS count
     FROM app_bug_reports
     WHERE reporter_user_id = ? AND trigger = ? AND created_at >= ?`,
  ).get(reporterUserId, trigger, since) as { count: number }).count);
}

function enforceRateLimit(
  database: NyxDatabase,
  reporterUserId: string,
  trigger: AppBugReportRequest["trigger"],
  now: Date,
) {
  if (trigger === "manual") {
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    if (
      countReports(database, reporterUserId, trigger, tenMinutesAgo) >= MANUAL_TEN_MINUTE_LIMIT
      || countReports(database, reporterUserId, trigger, dayAgo) >= MANUAL_DAILY_LIMIT
    ) {
      throw new BugReportError("RATE_LIMITED", "Too many manual bug reports.");
    }
    return;
  }
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
  if (
    countReports(database, reporterUserId, trigger, hourAgo)
    >= AUTOMATIC_HOURLY_FINGERPRINT_LIMIT
  ) {
    throw new BugReportError("RATE_LIMITED", "Too many automatic bug reports.");
  }
}

function isReportCodeCollision(error: unknown) {
  return error instanceof Error
    && /UNIQUE constraint failed: app_bug_reports\.report_code/.test(error.message);
}

export function purgeExpiredBugReports(
  database: NyxDatabase,
  now = new Date(),
  batchSize = 500,
) {
  let removed = 0;
  for (;;) {
    const result = database.prepare(
      `DELETE FROM app_bug_reports
       WHERE id IN (
         SELECT id FROM app_bug_reports
         WHERE expires_at <= ?
         ORDER BY expires_at
         LIMIT ?
       )`,
    ).run(now.toISOString(), batchSize);
    removed += result.changes;
    if (result.changes < batchSize) return removed;
  }
}

export function createAppBugReport(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string | null;
    reporterUserId: string;
    report: AppBugReportRequest;
  },
  now = new Date(),
) {
  purgeExpiredBugReports(database, now);
  const replay = existingReport(
    database,
    input.workspaceId,
    input.reporterUserId,
    input.report.clientReportId,
  );
  if (replay) return replay;

  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + retentionDays() * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const sourceRevision = process.env.NYXDOC_SOURCE_REVISION?.trim() || "development";
  const fingerprint = input.report.trigger === "automatic"
    ? automaticFingerprint({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        report: input.report,
        sourceRevision,
      })
    : null;

  if (fingerprint) {
    const recent = database.prepare(
      `SELECT id, report_code AS reportCode, trigger, category,
              category_source AS categorySource, detector, reason_code AS reasonCode,
              captured_at AS capturedAt, created_at AS createdAt, expires_at AS expiresAt,
              occurrence_count AS occurrenceCount
       FROM app_bug_reports
       WHERE fingerprint = ? AND last_seen_at >= ?
       ORDER BY last_seen_at DESC
       LIMIT 1`,
    ).get(
      fingerprint,
      new Date(now.getTime() - AUTOMATIC_DEDUPE_MS).toISOString(),
    ) as BugReportRow | undefined;
    if (recent) {
      database.prepare(
        `UPDATE app_bug_reports
         SET occurrence_count = occurrence_count + 1, last_seen_at = ?, expires_at = ?
         WHERE id = ?`,
      ).run(createdAt, expiresAt, recent.id);
      return {
        ...recent,
        occurrenceCount: recent.occurrenceCount + 1,
        expiresAt,
        deduplicated: true,
      } satisfies BugReportRow;
    }
  }

  enforceRateLimit(database, input.reporterUserId, input.report.trigger, now);
  const {
    category,
    categorySource,
    capturedAt,
    description,
    detector,
    documentId: _untrustedDocumentId,
    reasonCode,
    trigger,
    ...payload
  } = input.report;
  void _untrustedDocumentId;
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new BugReportError("TOO_LARGE", "The bug report payload is too large.");
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomUUID();
    const code = reportCode(now);
    try {
      database.prepare(
        `INSERT INTO app_bug_reports
         (id, report_code, client_report_id, workspace_id, document_id, reporter_user_id,
          schema_version, trigger, category, category_source, detector, reason_code,
          captured_at, description, app_version, source_revision, fingerprint,
          occurrence_count, first_seen_at, last_seen_at, payload_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        code,
        input.report.clientReportId,
        input.workspaceId,
        input.documentId,
        input.reporterUserId,
        trigger,
        category,
        categorySource,
        detector ?? null,
        reasonCode,
        capturedAt,
        description || null,
        packageJson.version,
        sourceRevision.slice(0, 120),
        fingerprint,
        createdAt,
        createdAt,
        payloadJson,
        createdAt,
        expiresAt,
      );
      return {
        id,
        reportCode: code,
        trigger,
        category,
        categorySource,
        detector: detector ?? null,
        reasonCode,
        capturedAt,
        createdAt,
        expiresAt,
        occurrenceCount: 1,
      } satisfies BugReportRow;
    } catch (error) {
      const concurrentReplay = existingReport(
        database,
        input.workspaceId,
        input.reporterUserId,
        input.report.clientReportId,
      );
      if (concurrentReplay) return concurrentReplay;
      if (!isReportCodeCollision(error) || attempt === 4) throw error;
    }
  }
  throw new Error("Could not allocate a bug report code.");
}

export function getAppBugReportByCode(
  database: NyxDatabase,
  code: string,
  now = new Date(),
): AppBugReport | null {
  const row = database.prepare(
    `SELECT id, report_code AS reportCode, client_report_id AS clientReportId,
            workspace_id AS workspaceId, document_id AS documentId,
            reporter_user_id AS reporterUserId, trigger, category,
            category_source AS categorySource, detector, reason_code AS reasonCode,
            captured_at AS capturedAt, description, app_version AS appVersion,
            source_revision AS sourceRevision, occurrence_count AS occurrenceCount,
            first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
            payload_json AS payloadJson, created_at AS createdAt, expires_at AS expiresAt
     FROM app_bug_reports
     WHERE report_code = ? AND expires_at > ?`,
  ).get(code, now.toISOString()) as (BugReportRow & {
    clientReportId: string;
    workspaceId: string;
    documentId: string | null;
    reporterUserId: string | null;
    description: string | null;
    appVersion: string;
    sourceRevision: string;
    firstSeenAt: string;
    lastSeenAt: string;
    payloadJson: string;
  }) | undefined;
  if (!row) return null;
  const { payloadJson, ...report } = row;
  return {
    ...report,
    payload: JSON.parse(payloadJson) as AppBugReport["payload"],
  };
}
