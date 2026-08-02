import { describe, expect, it } from "vitest";
import {
  agentCreateDocumentSchema,
  agentUpdateDocumentSchema,
  createDocumentSchema,
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
    expect(updateDocumentSchema.parse({ baseRevision: 1, content })).toMatchObject({ content });
    expect(updateDocumentSchema.safeParse({
      baseRevision: 1,
      blocks: [{ type: "paragraph", content: "구형 본문" }],
    }).success).toBe(false);
  });

  it("requires requestId at every external agent write boundary", () => {
    expect(agentCreateDocumentSchema.safeParse({ title: "Agent 문서", content }).success).toBe(false);
    expect(agentCreateDocumentSchema.safeParse({
      requestId: "agent-create-001",
      title: "Agent 문서",
      content,
    }).success).toBe(true);
    expect(agentUpdateDocumentSchema.safeParse({ baseRevision: 1, content }).success).toBe(false);
    expect(agentUpdateDocumentSchema.safeParse({
      requestId: "agent-update-001",
      baseRevision: 1,
      content,
    }).success).toBe(true);
  });
});
