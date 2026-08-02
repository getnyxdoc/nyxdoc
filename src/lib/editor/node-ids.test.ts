import { describe, expect, it } from "vitest";
import { documentNodeIdRepairs, repairDocumentNodeIds } from "@/lib/editor/node-ids";

const duplicateTree = [
  { id: "heading", type: "h1", children: [{ text: "제목" }] },
  {
    id: "table",
    type: "table",
    children: [{
      id: "row",
      type: "tr",
      children: [{
        id: "cell",
        type: "td",
        children: [{ id: "duplicate", type: "p", children: [{ text: "셀" }] }],
      }],
    }],
  },
  { id: "duplicate", type: "p", children: [{ text: "뒤 문단" }] },
];

describe("document node ID repair", () => {
  it("assigns a fresh ID only to later duplicates, including nested blocks", () => {
    const repaired = repairDocumentNodeIds(duplicateTree, () => "replacement");

    expect(repaired.repairs).toEqual([{
      path: [2],
      previousId: "duplicate",
      nextId: "replacement",
      reason: "duplicate",
    }]);
    const nestedTable = repaired.value[1] as {
      children: Array<{ children: Array<{ children: Array<{ id: string }> }> }>;
    };
    expect(nestedTable.children[0].children[0].children[0].id).toBe("duplicate");
    expect(repaired.value[2].id).toBe("replacement");
    expect(duplicateTree[2].id).toBe("duplicate");
  });

  it("does not change an already valid tree", () => {
    const validTree = duplicateTree.slice(0, 2);
    expect(documentNodeIdRepairs(validTree, () => "unused")).toEqual([]);
    const repaired = repairDocumentNodeIds(validTree, () => "unused");
    expect(repaired.value).toBe(validTree);
    expect(repaired.repairs).toEqual([]);
  });

  it("assigns IDs to missing top-level, nested, and inline elements without touching text leaves", () => {
    const missingTree = [
      {
        type: "p",
        children: [{
          type: "a",
          url: "https://example.com",
          children: [{ text: "외부 문서" }],
        }],
      },
      {
        id: "table",
        type: "table",
        children: [{
          type: "tr",
          children: [{
            type: "td",
            children: [{ type: "p", children: [{ text: "셀" }] }],
          }],
        }],
      },
    ];
    let sequence = 0;
    const repaired = repairDocumentNodeIds(missingTree, () => `generated-${++sequence}`);

    expect(repaired.repairs.map((repair) => ({
      path: repair.path,
      reason: repair.reason,
    }))).toEqual([
      { path: [0], reason: "missing" },
      { path: [0, 0], reason: "missing" },
      { path: [1, 0], reason: "missing" },
      { path: [1, 0, 0], reason: "missing" },
      { path: [1, 0, 0, 0], reason: "missing" },
    ]);
    expect(repaired.value[0]).toMatchObject({
      id: "generated-1",
      children: [{
        id: "generated-2",
        children: [{ text: "외부 문서" }],
      }],
    });
    expect(JSON.stringify(repaired.value)).toContain('"text":"셀"');
    expect(JSON.stringify(repaired.value)).not.toContain('"text":{"id"');
  });
});
