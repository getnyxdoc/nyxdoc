import { describe, expect, it } from "vitest";
import type { DocumentSummary } from "@/lib/documents/types";
import { reorderSiblingDocumentSummaries } from "@/lib/documents/tree-order";

function document(
  id: string,
  treeOrder: number,
  parentDocumentId: string | null = "parent",
): DocumentSummary {
  return {
    id,
    title: id,
    slug: id,
    status: "active",
    parentDocumentId,
    treeOrder,
    revisionId: `revision-${id}`,
    revisionNumber: 1,
    documentType: null,
    workflowStatus: "draft",
    tags: [],
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("document tree ordering", () => {
  it("moves one sibling before another and normalizes sibling orders", () => {
    const result = reorderSiblingDocumentSummaries([
      document("00", 100),
      document("01", 200),
      document("02", 300),
      document("other-root", 100, null),
    ], "02", "00", "before");

    expect(result
      .filter((item) => item.parentDocumentId === "parent")
      .sort((left, right) => left.treeOrder - right.treeOrder)
      .map((item) => [item.id, item.treeOrder]))
      .toEqual([["02", 100], ["00", 200], ["01", 300]]);
    expect(result.find((item) => item.id === "other-root")?.treeOrder).toBe(100);
  });

  it("does not move a document across parent boundaries", () => {
    const documents = [document("child", 100), document("root", 100, null)];
    expect(reorderSiblingDocumentSummaries(documents, "child", "root", "after"))
      .toBe(documents);
  });
});
