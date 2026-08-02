import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import {
  createEditorCaretIncident,
  getEditorCaretIncidentByCode,
} from "@/lib/editor/caret-incidents";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import type { EditorCaretIncidentRequest } from "@/lib/editor/diagnostics";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

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
    title: "캐럿 진단 테스트",
    content: parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: [{ id: randomUUID(), type: "p", children: [{ text: "본문" }] }],
    }),
  });
  return { database, document: created.document, user, workspace };
}

function incidentInput(
  workspaceId: string,
  documentId: string,
  overrides: Partial<EditorCaretIncidentRequest> = {},
): EditorCaretIncidentRequest {
  return {
    workspaceId,
    documentId,
    clientIncidentId: randomUUID(),
    trigger: "manual",
    reason: "manual",
    mountCount: 1,
    environment: {
      browser: "chrome",
      browserMajor: 140,
      platform: "windows",
      viewportWidth: 1200,
      viewportHeight: 900,
      devicePixelRatio: 1,
      locale: "ko",
    },
    trace: [{
      sequence: 0,
      elapsedMs: 25,
      kind: "manual_report",
      action: "manual",
      selection: {
        kind: "text",
        collapsed: true,
        anchor: { path: [0, 0], offset: 2 },
        focus: { path: [0, 0], offset: 2 },
        selectedCellCount: 0,
      },
      blockCount: 1,
      composing: false,
      focused: true,
    }],
    ...overrides,
  };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("editor caret incidents", () => {
  it("stores a bounded structural trace and replays the same client request safely", () => {
    const { database, document, user, workspace } = fixture();
    const input = incidentInput(workspace.id, document.id);

    const first = createEditorCaretIncident(database, user.id, input);
    const replay = createEditorCaretIncident(database, user.id, input);
    expect(replay).toEqual(first);

    const stored = getEditorCaretIncidentByCode(database, first.incidentCode);
    expect(stored).toMatchObject({
      workspaceId: workspace.id,
      documentId: document.id,
      userId: user.id,
      clientIncidentId: input.clientIncidentId,
      trigger: "manual",
      reason: "manual",
      mountCount: 1,
      environment: input.environment,
      trace: input.trace,
    });
    expect(JSON.stringify(stored)).not.toContain("본문");
    expect(first.incidentCode).toMatch(/^CAR-\d{8}-[0-9A-F]{8}$/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM editor_caret_incidents").get())
      .toEqual({ count: 1 });
  });

  it("purges expired traces opportunistically when a new incident is stored", () => {
    const { database, document, user, workspace } = fixture();
    const expired = createEditorCaretIncident(
      database,
      user.id,
      incidentInput(workspace.id, document.id),
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(getEditorCaretIncidentByCode(
      database,
      expired.incidentCode,
      new Date("2026-01-02T00:00:00.000Z"),
    )).not.toBeNull();

    createEditorCaretIncident(
      database,
      user.id,
      incidentInput(workspace.id, document.id),
      new Date("2026-02-02T00:00:00.000Z"),
    );
    expect(getEditorCaretIncidentByCode(database, expired.incidentCode)).toBeNull();
  });

  it("rejects moving an incident across a document workspace boundary", () => {
    const { database, document, user, workspace } = fixture();
    const other = createTestUser(database);
    const incident = createEditorCaretIncident(
      database,
      user.id,
      incidentInput(workspace.id, document.id),
    );

    expect(() => database.prepare(
      "UPDATE editor_caret_incidents SET workspace_id = ? WHERE id = ?",
    ).run(other.workspace.id, incident.id)).toThrow(/document workspace/);
  });
});
