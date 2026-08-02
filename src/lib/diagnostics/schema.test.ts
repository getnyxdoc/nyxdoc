import { describe, expect, it } from "vitest";
import {
  parseAppBugReportRequest,
  sanitizeEditorTrace,
  type AppBugReportRequest,
} from "@/lib/diagnostics/schema";
import type { CaretTraceEvent } from "@/lib/editor/diagnostics";

function report(): AppBugReportRequest {
  return {
    schemaVersion: 1,
    clientReportId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    trigger: "manual",
    category: "save_sync",
    categorySource: "suggested",
    suggestedCategory: "save_sync",
    reasonCode: "manual_report",
    capturedAt: "2026-07-30T00:00:00.000Z",
    clientBuildSha: "development",
    documentId: "33333333-3333-4333-8333-333333333333",
    environment: {
      browser: "chrome",
      browserMajor: 140,
      platform: "windows",
      viewportClass: "wide",
      locale: "ko",
      online: true,
    },
    snapshot: {
      surface: "editor",
      editorMode: "edit",
      canonicalRevision: 3,
      generation: 2,
      draftVersion: 7,
      committedDraftVersion: 6,
      dirty: true,
      syncState: "error",
      validationState: "valid",
      visibility: "visible",
      accessKind: "membership",
      workspaceRole: "owner",
      canRead: true,
      canEdit: true,
      canCommit: true,
      canShare: true,
      blockCount: "eleven_to_hundred",
      textLength: "hundred_one_to_thousand",
      nodeTypeCount: "one_to_ten",
      documentCount: "eleven_to_hundred",
      sidebarWidth: "standard",
    },
    events: [{
      sequence: 0,
      offsetMs: -250,
      kind: "request",
      operation: "collaboration_commit",
      method: "POST",
      outcome: "server_error",
      status: 500,
      duration: "500_to_1999ms",
      operationId: "44444444-4444-4444-8444-444444444444",
    }],
  };
}

describe("app bug report schema", () => {
  it("accepts a bounded semantic report without page content", () => {
    expect(parseAppBugReportRequest(report())).toMatchObject({
      category: "save_sync",
      snapshot: { dirty: true, syncState: "error" },
    });
  });

  it("rejects URLs, request bodies, and other unapproved diagnostics", () => {
    const input = structuredClone(report()) as unknown as {
      environment: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };
    input.environment.userAgent = "private browser data";
    input.events[0].url = "https://private.example/document?token=secret";
    input.events[0].requestBody = "private document text";
    expect(() => parseAppBugReportRequest(input)).toThrow();
  });

  it("rejects automatic reports that are not emitted by a known detector", () => {
    const input = {
      ...report(),
      trigger: "automatic",
      category: "other",
      categorySource: "suggested",
    };
    expect(() => parseAppBugReportRequest(input)).toThrow();
  });

  it("sanitizes editor traces into structural buckets", () => {
    const source: CaretTraceEvent[] = [{
      sequence: 4,
      elapsedMs: 1_000,
      kind: "keydown",
      key: "text",
      operationTypes: ["insert_text"],
      selection: {
        kind: "text",
        collapsed: true,
        anchor: { path: [12, 4, 1], offset: 847 },
        focus: { path: [12, 4, 1], offset: 847 },
        selectedCellCount: 0,
      },
      blockCount: 240,
      composing: false,
      focused: true,
    }];
    const sanitized = sanitizeEditorTrace(source);
    expect(sanitized).toEqual([{
      sequence: 4,
      offsetMs: 0,
      kind: "text_edit",
      selection: {
        kind: "text",
        collapsed: true,
        topLevelBlock: "eleven_to_hundred",
        pathDepth: 3,
        selectedCells: "zero",
      },
      operationClass: "text",
      blockCount: "hundred_one_to_thousand",
      composing: false,
      focused: true,
    }]);
    expect(JSON.stringify(sanitized)).not.toContain("847");
    expect(JSON.stringify(sanitized)).not.toContain("insert_text");
  });
});
