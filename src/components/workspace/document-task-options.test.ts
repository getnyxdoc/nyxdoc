import { describe, expect, it } from "vitest";
import {
  listAgentProfilePermissions,
  type AgentAccessProfile,
  type WorkspacePermission,
} from "@/lib/authz/permissions";
import type { WorkspaceAgentSummary } from "@/lib/collaboration/types";
import {
  buildTaskDocumentTree,
  orderedActiveTaskAgents,
  preferredTaskAgentId,
} from "./document-task-options";

function agent(
  id: string,
  displayName: string,
  accessProfile: AgentAccessProfile,
  status: WorkspaceAgentSummary["status"] = "active",
  extraCapabilities: WorkspacePermission[] = [],
): WorkspaceAgentSummary {
  return {
    id,
    agentIdentityId: `identity-${id}`,
    displayName,
    avatarMediaId: null,
    accessProfile,
    capabilities: [
      ...listAgentProfilePermissions(accessProfile),
      ...extraCapabilities,
    ],
    status,
    activeAssignmentCount: 0,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

describe("Agent To-do options", () => {
  it("uses the only active agent as the default", () => {
    expect(preferredTaskAgentId([
      agent("disabled-manager", "비활성 관리자", "custom", "disabled", ["tasks.manage"]),
      agent("only-agent", "단독 에이전트", "reader"),
    ])).toBe("only-agent");
  });

  it("orders active agents by effective capabilities and then name", () => {
    const agents = [
      agent("reader", "읽기", "reader"),
      agent("writer-z", "하 문서 작업", "writer"),
      agent("manager-z", "하 관리자", "custom", "active", ["tasks.manage"]),
      agent("manager-a", "가 관리자", "custom", "active", ["tasks.manage"]),
      agent("disabled", "비활성", "custom", "disabled", ["tasks.manage"]),
    ];

    expect(orderedActiveTaskAgents(agents).map((item) => item.id)).toEqual([
      "manager-a",
      "manager-z",
      "writer-z",
      "reader",
    ]);
    expect(preferredTaskAgentId(agents)).toBe("manager-a");
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
