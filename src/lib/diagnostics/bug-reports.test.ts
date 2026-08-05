import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import {
  BugReportError,
  createAppBugReport,
  getAppBugReportByCode,
  purgeExpiredBugReports,
} from "@/lib/diagnostics/bug-reports";
import type { AppBugReportRequest } from "@/lib/diagnostics/schema";
import { createDocument } from "@/lib/documents/service";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import { storeMediaAsset } from "@/lib/media/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];
const mediaRoots: string[] = [];
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const created = createDocument(database, workspace.id, {
    type: "human",
    userId: user.id,
    label: user.name,
    source: "web",
  }, {
    title: "Private document title",
    content: parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [{
        id: randomUUID(),
        type: "p",
        children: [{ text: "private document body" }],
      }],
    }),
  });
  return { database, document: created.document, user, workspace };
}

function report(
  documentId: string,
  overrides: Partial<AppBugReportRequest> = {},
): AppBugReportRequest {
  return {
    schemaVersion: 1,
    clientReportId: randomUUID(),
    sessionId: randomUUID(),
    trigger: "manual",
    category: "navigation_tree",
    categorySource: "suggested",
    suggestedCategory: "navigation_tree",
    reasonCode: "manual_report",
    capturedAt: "2026-07-30T00:00:00.000Z",
    clientBuildSha: "development",
    documentId,
    environment: {
      browser: "edge",
      browserMajor: 140,
      platform: "windows",
      viewportClass: "wide",
      locale: "ko",
      online: true,
    },
    snapshot: {
      surface: "tree",
      editorMode: "edit",
      canonicalRevision: 1,
      generation: 1,
      draftVersion: 2,
      committedDraftVersion: 1,
      dirty: true,
      syncState: "synced",
      validationState: "valid",
      visibility: "visible",
      accessKind: "membership",
      workspaceRole: "owner",
      canRead: true,
      canEdit: true,
      canCommit: true,
      canShare: true,
      blockCount: "one_to_ten",
      textLength: "one_to_ten",
      nodeTypeCount: "one_to_ten",
      documentCount: "one_to_ten",
      sidebarWidth: "standard",
    },
    events: [{
      sequence: 0,
      offsetMs: -20,
      kind: "tree",
      action: "collapse",
    }],
    ...overrides,
  };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (mediaRoots.length) {
    const mediaRoot = mediaRoots.pop();
    if (mediaRoot) rmSync(mediaRoot, { force: true, recursive: true });
  }
});

describe("app bug reports", () => {
  it("stores an idempotent bounded report without reading document content", async () => {
    const { database, document, user, workspace } = fixture();
    const input = report(document.id);
    const first = await createAppBugReport(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      report: input,
    });
    const replay = await createAppBugReport(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      report: input,
    });
    expect(replay.reportCode).toBe(first.reportCode);
    expect(first.createdNew).toBe(true);
    expect(replay.createdNew).toBe(false);
    expect(first.reportCode).toMatch(/^BUG-\d{8}-[0-9A-F]{12}$/);

    const stored = getAppBugReportByCode(database, first.reportCode);
    expect(stored).toMatchObject({
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      category: "navigation_tree",
      occurrenceCount: 1,
    });
    expect(JSON.stringify(stored)).not.toContain("Private document title");
    expect(JSON.stringify(stored)).not.toContain("private document body");
    expect(database.prepare("SELECT COUNT(*) AS count FROM app_bug_reports").get())
      .toEqual({ count: 1 });
  });

  it("deduplicates the same automatic detector fingerprint for fifteen minutes", async () => {
    const { database, document, user, workspace } = fixture();
    const automatic = report(document.id, {
      trigger: "automatic",
      category: "editor_caret",
      categorySource: "detector",
      detector: "table_cell_changed",
      reasonCode: "table_cell_changed",
      suggestedCategory: undefined,
      events: [],
    });
    const first = await createAppBugReport(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      report: automatic,
    }, new Date("2026-07-30T00:00:00.000Z"));
    const duplicate = await createAppBugReport(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      report: { ...automatic, clientReportId: randomUUID() },
    }, new Date("2026-07-30T00:05:00.000Z"));
    expect(duplicate.reportCode).toBe(first.reportCode);
    expect(duplicate.occurrenceCount).toBe(2);
    expect(duplicate.deduplicated).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM app_bug_reports").get())
      .toEqual({ count: 1 });
  });

  it("rate limits repeated manual submissions", async () => {
    const { database, document, user, workspace } = fixture();
    const now = new Date("2026-07-30T00:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      await createAppBugReport(database, {
        workspaceId: workspace.id,
        documentId: document.id,
        reporterUserId: user.id,
        report: report(document.id),
      }, now);
    }
    await expect(createAppBugReport(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      report: report(document.id),
    }, now)).rejects.toThrowError(BugReportError);
  });

  it("enforces the document-workspace boundary and hides expired reports", async () => {
    const { database, document, user, workspace } = fixture();
    const other = createTestUser(database);
    await expect(createAppBugReport(database, {
      workspaceId: other.workspace.id,
      documentId: document.id,
      reporterUserId: other.user.id,
      report: report(document.id),
    })).rejects.toThrow(/workspace/);

    const stored = await createAppBugReport(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      report: report(document.id),
    }, new Date("2026-01-01T00:00:00.000Z"));
    expect(getAppBugReportByCode(
      database,
      stored.reportCode,
      new Date("2026-02-01T00:00:01.000Z"),
    )).toBeNull();
  });

  it("binds explicit images to a manual report and removes them at expiry", async () => {
    const { database, document, user, workspace } = fixture();
    const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "nyxdoc-bug-media-test-"));
    mediaRoots.push(mediaRoot);
    const media = await storeMediaAsset(database, {
      bytes: PNG_BYTES,
      originalFilename: "save-error.png",
      purpose: "diagnostic",
      userId: user.id,
      workspaceId: workspace.id,
    }, mediaRoot);
    const stored = await createAppBugReport(database, {
      workspaceId: workspace.id,
      documentId: document.id,
      reporterUserId: user.id,
      report: report(document.id),
      attachmentMediaIds: [media.id],
    }, new Date("2026-01-01T00:00:00.000Z"));

    expect(getAppBugReportByCode(
      database,
      stored.reportCode,
      new Date("2026-01-02T00:00:00.000Z"),
    )).toMatchObject({
      attachments: [{
        mediaId: media.id,
        mimeType: "image/png",
        originalFilename: "save-error.png",
        url: expect.stringContaining(`/bug-reports/${stored.reportCode}/attachments/`),
      }],
    });
    expect(existsSync(path.join(mediaRoot, media.storageKey))).toBe(true);

    await expect(purgeExpiredBugReports(
      database,
      new Date("2026-02-01T00:00:01.000Z"),
      500,
      mediaRoot,
    )).resolves.toBe(1);
    expect(getAppBugReportByCode(
      database,
      stored.reportCode,
      new Date("2026-02-01T00:00:01.000Z"),
    )).toBeNull();
    expect(database.prepare("SELECT id FROM media_assets WHERE id = ?").get(media.id))
      .toBeUndefined();
    expect(existsSync(path.join(mediaRoot, media.storageKey))).toBe(false);
  });
});
