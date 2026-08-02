import { describe, expect, it } from "vitest";
import {
  parseEditorCaretIncidentRequest,
  parseEditorDiagnosticEvent,
} from "@/lib/editor/diagnostics";

const base = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
};

describe("editor diagnostics", () => {
  it("accepts structural validation metadata without document content", () => {
    expect(parseEditorDiagnosticEvent({
      ...base,
      event: "validation_failed",
      details: {
        blockCount: 945,
        issueCount: 1,
        issues: [{
          code: "invalid_union",
          path: "blocks.0",
        }],
        nodeTypes: ["a", "p"],
        textLength: 182_000,
      },
    })).toMatchObject({
      event: "validation_failed",
      details: { blockCount: 945, textLength: 182_000 },
    });
  });

  it("rejects raw validation messages that could contain document text", () => {
    expect(() => parseEditorDiagnosticEvent({
      ...base,
      event: "validation_failed",
      details: {
        issues: [{
          code: "invalid_union",
          path: "blocks.0",
          message: "Value contained private document text",
        }],
      },
    })).toThrow();
  });

  it("rejects document text, URLs, and arbitrary diagnostic fields", () => {
    expect(() => parseEditorDiagnosticEvent({
      ...base,
      event: "link_failed",
      details: {
        kind: "external",
        url: "https://private.example/document",
        text: "문서 본문",
      },
    })).toThrow();
  });

  it("accepts link title conversion and reversible unlink events without URL content", () => {
    expect(parseEditorDiagnosticEvent({
      ...base,
      event: "link_auto_titled",
      details: { kind: "external", fetchedTitle: true },
    }).event).toBe("link_auto_titled");
    expect(parseEditorDiagnosticEvent({
      ...base,
      event: "link_unwrapped",
      details: { kind: "internal" },
    }).event).toBe("link_unwrapped");
  });

  it("accepts structural caret traces without document text", () => {
    const incident = parseEditorCaretIncidentRequest({
      ...base,
      clientIncidentId: "33333333-3333-4333-8333-333333333333",
      trigger: "manual",
      reason: "manual",
      mountCount: 1,
      environment: {
        browser: "chrome",
        browserMajor: 140,
        platform: "windows",
        viewportWidth: 800,
        viewportHeight: 1200,
        devicePixelRatio: 1,
        locale: "ko",
      },
      trace: [{
        sequence: 0,
        elapsedMs: 12,
        kind: "selection_change",
        selection: {
          kind: "text",
          collapsed: true,
          anchor: { path: [3, 1, 2, 0, 0], offset: 4 },
          focus: { path: [3, 1, 2, 0, 0], offset: 4 },
          table: { blockIndex: 3, rowIndex: 1, columnIndex: 2 },
          selectedCellCount: 0,
        },
        blockCount: 9,
        composing: false,
        focused: true,
      }],
    });
    expect(incident.trace[0].selection?.table).toEqual({
      blockIndex: 3,
      rowIndex: 1,
      columnIndex: 2,
    });
  });

  it("rejects text and arbitrary browser data from caret traces", () => {
    expect(() => parseEditorCaretIncidentRequest({
      ...base,
      clientIncidentId: "33333333-3333-4333-8333-333333333333",
      trigger: "manual",
      reason: "manual",
      mountCount: 1,
      environment: {
        browser: "chrome",
        browserMajor: 140,
        platform: "windows",
        viewportWidth: 800,
        viewportHeight: 1200,
        devicePixelRatio: 1,
        locale: "ko",
        userAgent: "private browser data",
      },
      trace: [{
        sequence: 0,
        elapsedMs: 12,
        kind: "beforeinput",
        inputType: "insertText",
        text: "비밀 문서 내용",
        composing: false,
        focused: true,
      }],
    })).toThrow();
  });
});
