import { describe, expect, it } from "vitest";
import type { WorkspaceAgentSummary } from "@/lib/collaboration/types";
import {
  buildTaskDocumentTree,
  orderedActiveTaskAgents,
  preferredTaskAgentId,
} from "./document-task-options";

function agent(
  id: string,
  displayName: string,
  role: WorkspaceAgentSummary["role"],
  status: WorkspaceAgentSummary["status"] = "active",
): WorkspaceAgentSummary {
  return {
    id,
    displayName,
    avatarMediaId: null,
    role,
    status,
    activeAssignmentCount: 0,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

describe("Agent To-do options", () => {
  it("uses the only active agent as the default", () => {
    expect(preferredTaskAgentId([
      agent("disabled-admin", "비활성 관리자", "admin", "disabled"),
      agent("only-agent", "단독 에이전트", "viewer"),
    ])).toBe("only-agent");
  });

  it("orders active agents by workspace role and then name", () => {
    const agents = [
      agent("viewer", "뷰어", "viewer"),
      agent("editor-z", "하 편집자", "editor"),
      agent("admin-z", "하 관리자", "admin"),
      agent("admin-a", "가 관리자", "admin"),
      agent("disabled", "비활성", "admin", "disabled"),
    ];

    expect(orderedActiveTaskAgents(agents).map((item) => item.id)).toEqual([
      "admin-a",
      "admin-z",
      "editor-z",
      "viewer",
    ]);
    expect(preferredTaskAgentId(agents)).toBe("admin-a");
  });

  it("builds a sorted document tree with path and ancestor context", () => {
    const rows = buildTaskDocumentTree([
      { id: "child-b", parentDocumentId: "root", title: "두 번째", treeOrder: 200 },
      { id: "root", parentDocumentId: null, title: "루트", treeOrder: 100 },
      { id: "grandchild", parentDocumentId: "child-a", title: "하위", treeOrder: 100 },
      { id: "child-a", parentDocumentId: "root", title: "첫 번째", treeOrder: 100 },
    ]);

    expect(rows.map((row) => row.document.id)).toEqual([
      "root",
      "child-a",
      "grandchild",
      "child-b",
    ]);
    expect(rows.find((row) => row.document.id === "root")).toMatchObject({
      depth: 0,
      hasChildren: true,
      path: ["루트"],
    });
    expect(rows.find((row) => row.document.id === "grandchild")).toMatchObject({
      ancestors: ["root", "child-a"],
      depth: 2,
      hasChildren: false,
      path: ["루트", "첫 번째", "하위"],
    });
  });
});
