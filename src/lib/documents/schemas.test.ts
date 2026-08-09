import { describe, expect, it } from "vitest";
import {
  agentCreateDocumentSchema,
  agentUpdateDocumentSchema,
  createDocumentSchema,
  discardWorkingDocumentSchema,
  reorderDocumentSchema,
  restoreDocumentRevisionSchema,
  restoreWorkingRevisionSchema,
  updateDocumentSchema,
} from "@/lib/documents/schemas";

const content = {
  schemaVersion: 2 as const,
  blocks: [{ id: "schema-test-body", type: "p" as const, children: [{ text: "정본 본문" }] }],
};

describe("canonical document API schemas", () => {
  it("accepts only AST v2 content when creating a document", () => {
    expect(createDocumentSchema.parse({ title: "정본 문서", content })).toMatchObject({ content });
    expect(createDocumentSchema.safeParse({
      title: "구형 문서",
      blocks: [{ type: "paragraph", content: "구형 본문" }],
    }).success).toBe(false);
    expect(createDocumentSchema.safeParse({
      title: "혼합 문서",
      content,
      blocks: [{ type: "paragraph", content: "무시되면 안 되는 필드" }],
    }).success).toBe(false);
  });

  it("rejects legacy body fields during updates", () => {
    expect(updateDocumentSchema.parse({
      baseRevision: 1,
      expectedDraftVersion: 0,
      content,
    })).toMatchObject({ content });
    expect(updateDocumentSchema.safeParse({
      baseRevision: 1,
      expectedDraftVersion: 0,
      blocks: [{ type: "paragraph", content: "구형 본문" }],
    }).success).toBe(false);
  });

  it("requires the draft version observed by a human canonical update", () => {
    expect(updateDocumentSchema.safeParse({
      baseRevision: 1,
      title: "관찰 버전 없는 제목",
    }).success).toBe(false);
    expect(updateDocumentSchema.parse({
      baseRevision: 1,
      expectedDraftVersion: 0,
      title: "관찰한 초안의 제목",
    })).toMatchObject({
      baseRevision: 1,
      expectedDraftVersion: 0,
      title: "관찰한 초안의 제목",
    });
  });

  it("requires requestId at every external agent write boundary", () => {
    expect(agentCreateDocumentSchema.safeParse({ title: "Agent 문서", content }).success).toBe(false);
    expect(agentCreateDocumentSchema.safeParse({
      requestId: "agent-create-001",
      title: "Agent 문서",
      content,
    }).success).toBe(true);
    expect(agentUpdateDocumentSchema.safeParse({
      baseRevision: 1,
      expectedDraftVersion: 0,
      content,
    }).success).toBe(false);
    expect(agentUpdateDocumentSchema.safeParse({
      requestId: "agent-update-001",
      baseRevision: 1,
      expectedDraftVersion: 0,
      content,
    }).success).toBe(true);
  });

  it("requires an explicit draft CAS for destructive discard and restore requests", () => {
    const cas = {
      expectedGeneration: 3,
      expectedDraftVersion: 7,
      expectedBaseRevision: 5,
    };
    expect(discardWorkingDocumentSchema.safeParse({
      documentId: "7dcc9c33-5e68-41e4-af95-5933df3718d7",
    }).success).toBe(false);
    expect(discardWorkingDocumentSchema.parse({
      requestId: "discard-with-cas-001",
      documentId: "7dcc9c33-5e68-41e4-af95-5933df3718d7",
      ...cas,
    })).toMatchObject(cas);
    expect(restoreWorkingRevisionSchema.safeParse({
      requestId: "restore-without-cas-001",
    }).success).toBe(false);
    expect(restoreWorkingRevisionSchema.parse({
      requestId: "restore-with-cas-001",
      ...cas,
    })).toMatchObject(cas);
    expect(restoreDocumentRevisionSchema.safeParse({
      requestId: "restore-without-cas-002",
      baseRevision: 5,
    }).success).toBe(false);
    expect(restoreDocumentRevisionSchema.parse({
      requestId: "restore-with-cas-002",
      baseRevision: 5,
      expectedGeneration: cas.expectedGeneration,
      expectedDraftVersion: cas.expectedDraftVersion,
    })).toMatchObject({
      baseRevision: 5,
      expectedGeneration: cas.expectedGeneration,
      expectedDraftVersion: cas.expectedDraftVersion,
    });
  });

  it("requires a stable requestId for human discard and revision restore", () => {
    const discard = {
      documentId: "7dcc9c33-5e68-41e4-af95-5933df3718d7",
      expectedGeneration: 3,
      expectedDraftVersion: 7,
      expectedBaseRevision: 5,
    };
    const restore = {
      baseRevision: 5,
      expectedGeneration: 3,
      expectedDraftVersion: 7,
    };

    expect(discardWorkingDocumentSchema.safeParse(discard).success).toBe(false);
    expect(discardWorkingDocumentSchema.safeParse({
      requestId: "discard-stable-request-001",
      ...discard,
    }).success).toBe(true);
    expect(restoreDocumentRevisionSchema.safeParse(restore).success).toBe(false);
    expect(restoreDocumentRevisionSchema.safeParse({
      requestId: "restore-stable-request-001",
      ...restore,
    }).success).toBe(true);
  });

  it("accepts before, inside, and after positions for document tree moves", () => {
    const targetDocumentId = "7dcc9c33-5e68-41e4-af95-5933df3718d7";
    for (const position of ["before", "inside", "after"] as const) {
      const requestId = `tree-reorder-${position}`;
      expect(reorderDocumentSchema.parse({ requestId, targetDocumentId, position }))
        .toEqual({ requestId, targetDocumentId, position });
    }
  });
});
