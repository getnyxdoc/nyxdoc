import { describe, expect, it } from "vitest";
import type { DocumentSummary } from "@/lib/documents/types";
import { moveDocumentSummaryInTree } from "@/lib/documents/tree-order";

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
    const result = moveDocumentSummaryInTree([
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

  it("moves a whole branch inside another document and appends it to the children", () => {
    const documents = [
      document("07", 100, null),
      document("existing-child", 100, "07"),
      document("07-1", 200, null),
      document("07-1-child", 100, "07-1"),
    ];
    const result = moveDocumentSummaryInTree(documents, "07-1", "07", "inside");

    expect(result.find((item) => item.id === "07-1")).toMatchObject({
      parentDocumentId: "07",
      treeOrder: 200,
    });
    expect(result.find((item) => item.id === "07-1-child")?.parentDocumentId).toBe("07-1");
    expect(result
      .filter((item) => item.parentDocumentId === "07")
      .sort((left, right) => left.treeOrder - right.treeOrder)
      .map((item) => item.id))
      .toEqual(["existing-child", "07-1"]);
  });

  it("moves a document across parents before a destination sibling", () => {
    const result = moveDocumentSummaryInTree([
      document("source-parent", 100, null),
      document("source", 100, "source-parent"),
      document("destination-parent", 200, null),
      document("target", 100, "destination-parent"),
      document("after-target", 200, "destination-parent"),
    ], "source", "target", "before");

    expect(result
      .filter((item) => item.parentDocumentId === "destination-parent")
      .sort((left, right) => left.treeOrder - right.treeOrder)
      .map((item) => [item.id, item.treeOrder]))
      .toEqual([["source", 100], ["target", 200], ["after-target", 300]]);
  });

  it("rejects moving a document into its own descendant", () => {
    const documents = [
      document("source", 100, null),
      document("child", 100, "source"),
    ];
    expect(moveDocumentSummaryInTree(documents, "source", "child", "inside"))
      .toBe(documents);
  });
});
