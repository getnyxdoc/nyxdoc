import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import {
  archiveDocument,
  createDocument,
  getDocument,
  listDocuments,
  reorderDocumentTree,
  restoreTrashedDocument,
  updateDocument,
} from "@/lib/documents/service";
import type { DocumentActor } from "@/lib/documents/types";
import { parseNyxdocDocumentV2 } from "@/lib/editor/schema";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

type TreeRow = {
  id: string;
  workspace_id: string;
  status: "active" | "archived";
  lifecycle_state: "active" | "trashed";
  parent_document_id: string | null;
  tree_order: number;
  current_revision_id: string;
  revision_document_id: string;
  revision_number: number;
  max_revision_number: number;
};

function content(label: string) {
  return parseNyxdocDocumentV2({
    schemaVersion: 2,
    blocks: [{ id: randomUUID(), type: "p", children: [{ text: label }] }],
  });
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  const { user, workspace } = createTestUser(database);
  const actor: DocumentActor = {
    type: "human",
    userId: user.id,
    principalId: user.id,
    label: user.name,
    source: "web",
  };
  return { database, workspace, actor };
}

function rows(database: NyxDatabase, workspaceId: string) {
  return database.prepare(
    `SELECT d.id, d.workspace_id, d.status, d.lifecycle_state,
            d.parent_document_id, d.tree_order, d.current_revision_id,
            current_revision.document_id AS revision_document_id,
            current_revision.revision_number,
            (SELECT MAX(all_revisions.revision_number)
             FROM document_revisions all_revisions
             WHERE all_revisions.document_id = d.id) AS max_revision_number
     FROM documents d
     JOIN document_revisions current_revision ON current_revision.id = d.current_revision_id
     WHERE d.workspace_id = ?
     ORDER BY d.id`,
  ).all(workspaceId) as TreeRow[];
}

function activeChildIds(
  database: NyxDatabase,
  workspaceId: string,
  parentDocumentId: string | null,
) {
  return (database.prepare(
    `SELECT id
     FROM documents
     WHERE workspace_id = ? AND status = 'active' AND lifecycle_state = 'active'
       AND parent_document_id IS ?
     ORDER BY tree_order ASC, created_at ASC, id ASC`,
  ).all(workspaceId, parentDocumentId) as Array<{ id: string }>).map((row) => row.id);
}

function treeSnapshot(database: NyxDatabase, workspaceId: string) {
  return rows(database, workspaceId).map((row) => ({
    id: row.id,
    status: row.status,
    lifecycleState: row.lifecycle_state,
    parentDocumentId: row.parent_document_id,
    treeOrder: Number(row.tree_order),
    currentRevisionId: row.current_revision_id,
    revisionNumber: Number(row.revision_number),
  }));
}

function assertTreeInvariants(database: NyxDatabase, workspaceId: string) {
  const allRows = rows(database, workspaceId);
  const activeRows = allRows.filter(
    (row) => row.status === "active" && row.lifecycle_state === "active",
  );
  const activeById = new Map(activeRows.map((row) => [row.id, row]));

  for (const row of allRows) {
    expect(row.revision_document_id).toBe(row.id);
    expect(Number(row.revision_number)).toBe(Number(row.max_revision_number));
  }

  for (const row of activeRows) {
    if (row.parent_document_id !== null) {
      const parent = activeById.get(row.parent_document_id);
      expect(parent).toBeDefined();
      expect(parent?.workspace_id).toBe(row.workspace_id);
    }

    const visited = new Set<string>();
    let cursor: TreeRow | undefined = row;
    while (cursor) {
      expect(visited.has(cursor.id)).toBe(false);
      visited.add(cursor.id);
      cursor = cursor.parent_document_id === null
        ? undefined
        : activeById.get(cursor.parent_document_id);
    }
  }

  const siblingGroups = new Map<string | null, TreeRow[]>();
  for (const row of activeRows) {
    const siblings = siblingGroups.get(row.parent_document_id) ?? [];
    siblings.push(row);
    siblingGroups.set(row.parent_document_id, siblings);
  }
  for (const siblings of siblingGroups.values()) {
    siblings.sort((left, right) => Number(left.tree_order) - Number(right.tree_order));
    const orders = siblings.map((row) => Number(row.tree_order));
    expect(new Set(orders).size).toBe(orders.length);
    for (let index = 1; index < orders.length; index += 1) {
      expect(orders[index]).toBeGreaterThan(orders[index - 1]!);
    }
  }

  const expectedPreorder: string[] = [];
  const visit = (parentDocumentId: string | null) => {
    const siblings = [...(siblingGroups.get(parentDocumentId) ?? [])]
      .sort((left, right) => Number(left.tree_order) - Number(right.tree_order));
    for (const sibling of siblings) {
      expectedPreorder.push(sibling.id);
      visit(sibling.id);
    }
  };
  visit(null);
  expect(listDocuments(database, workspaceId).map((document) => document.id))
    .toEqual(expectedPreorder);
}

function expectServiceError(operation: () => unknown, code: string) {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

describe("document tree hardening invariants", () => {
  it.each([0x1a2b3c4d, 0x5e6f7788, 0x9abcdeff, 0x13579bdf])(
    "preserves deep hierarchy and sibling order through adversarial trace seed %i",
    (seed) => {
      const { database, workspace, actor } = fixture();
      const random = seededRandom(seed);
      const foreign = createTestUser(database, { name: `foreign-${seed}` });
      const foreignParent = createDocument(database, foreign.workspace.id, {
        type: "human",
        userId: foreign.user.id,
        principalId: foreign.user.id,
        label: foreign.user.name,
        source: "web",
      }, {
        title: `foreign-parent-${seed}`,
        content: content("foreign"),
      });

      const rootIds = Array.from({ length: 5 }, (_, index) => createDocument(
        database,
        workspace.id,
        actor,
        { title: `root-${seed}-${index}`, content: content(`root-${index}`) },
      ).document.id);
      const branchRootId = rootIds[1]!;
      const destinationRootId = rootIds[3]!;
      const childIds = Array.from({ length: 6 }, (_, index) => createDocument(
        database,
        workspace.id,
        actor,
        {
          title: `child-${seed}-${index}`,
          parentDocumentId: branchRootId,
          content: content(`child-${index}`),
        },
      ).document.id);
      const grandchildIds = Array.from({ length: 4 }, (_, index) => createDocument(
        database,
        workspace.id,
        actor,
        {
          title: `grandchild-${seed}-${index}`,
          parentDocumentId: childIds[2]!,
          content: content(`grandchild-${index}`),
        },
      ).document.id);
      const deepParentId = grandchildIds[1]!;
      const deepIds = Array.from({ length: 3 }, (_, index) => createDocument(
        database,
        workspace.id,
        actor,
        {
          title: `deep-${seed}-${index}`,
          parentDocumentId: deepParentId,
          content: content(`deep-${index}`),
        },
      ).document.id);
      const destinationChildIds = Array.from({ length: 3 }, (_, index) => createDocument(
        database,
        workspace.id,
        actor,
        {
          title: `destination-${seed}-${index}`,
          parentDocumentId: destinationRootId,
          content: content(`destination-${index}`),
        },
      ).document.id);
      assertTreeInvariants(database, workspace.id);

      for (let step = 0; step < 12; step += 1) {
        const current = activeChildIds(database, workspace.id, branchRootId);
        const sourceIndex = Math.floor(random() * current.length);
        let targetIndex = Math.floor(random() * current.length);
        if (targetIndex === sourceIndex) targetIndex = (targetIndex + 1) % current.length;
        const sourceId = current[sourceIndex]!;
        const targetId = current[targetIndex]!;
        reorderDocumentTree(database, workspace.id, actor, sourceId, {
          targetDocumentId: targetId,
          position: random() < 0.5 ? "before" : "after",
        });
        assertTreeInvariants(database, workspace.id);
      }

      const movingId = childIds[4]!;
      const beforeMove = activeChildIds(database, workspace.id, branchRootId)
        .filter((id) => id !== movingId);
      const destinationBeforeMove = activeChildIds(database, workspace.id, destinationRootId);
      const moving = getDocument(database, workspace.id, movingId);
      updateDocument(database, workspace.id, actor, movingId, {
        baseRevision: moving.revisionNumber,
        parentDocumentId: destinationRootId,
      });
      expect(activeChildIds(database, workspace.id, branchRootId)).toEqual(beforeMove);
      expect(activeChildIds(database, workspace.id, destinationRootId)).toEqual([
        ...destinationBeforeMove,
        movingId,
      ]);
      assertTreeInvariants(database, workspace.id);

      const unchangedBeforeInvalidMoves = treeSnapshot(database, workspace.id);
      const branchRevision = getDocument(database, workspace.id, branchRootId).revisionNumber;
      expectServiceError(() => updateDocument(database, workspace.id, actor, branchRootId, {
        baseRevision: branchRevision,
        parentDocumentId: deepIds[2]!,
      }), "INVALID_INPUT");
      expectServiceError(() => updateDocument(database, workspace.id, actor, childIds[2]!, {
        baseRevision: getDocument(database, workspace.id, childIds[2]!).revisionNumber,
        parentDocumentId: childIds[2]!,
      }), "INVALID_INPUT");
      expectServiceError(() => updateDocument(database, workspace.id, actor, childIds[0]!, {
        baseRevision: getDocument(database, workspace.id, childIds[0]!).revisionNumber,
        parentDocumentId: foreignParent.document.id,
      }), "NOT_FOUND");
      expectServiceError(() => reorderDocumentTree(
        database,
        workspace.id,
        actor,
        childIds[0]!,
        { targetDocumentId: childIds[0]!, position: "before" },
      ), "INVALID_INPUT");
      expect(treeSnapshot(database, workspace.id)).toEqual(unchangedBeforeInvalidMoves);
      assertTreeInvariants(database, workspace.id);

      const staleTargetId = destinationChildIds[0]!;
      const staleRevision = getDocument(database, workspace.id, staleTargetId).revisionNumber;
      updateDocument(database, workspace.id, actor, staleTargetId, {
        baseRevision: staleRevision,
        title: `fresh-title-${seed}`,
      });
      const treeAfterConcurrentWinner = treeSnapshot(database, workspace.id);
      expectServiceError(() => updateDocument(database, workspace.id, actor, staleTargetId, {
        baseRevision: staleRevision,
        parentDocumentId: branchRootId,
      }), "REVISION_CONFLICT");
      expect(treeSnapshot(database, workspace.id)).toEqual(treeAfterConcurrentWinner);
      assertTreeInvariants(database, workspace.id);

      const internalOrderBeforeTrash = new Map<string, string[]>([
        [branchRootId, activeChildIds(database, workspace.id, branchRootId)],
        [childIds[2]!, activeChildIds(database, workspace.id, childIds[2]!)],
        [deepParentId, activeChildIds(database, workspace.id, deepParentId)],
      ]);
      const branchBeforeTrash = getDocument(database, workspace.id, branchRootId);
      archiveDocument(database, workspace.id, actor, branchRootId, {
        baseRevision: branchBeforeTrash.revisionNumber,
      });
      assertTreeInvariants(database, workspace.id);

      const parentTrashedSnapshot = treeSnapshot(database, workspace.id);
      expectServiceError(() => updateDocument(
        database,
        workspace.id,
        actor,
        destinationChildIds[1]!,
        {
          baseRevision: getDocument(
            database,
            workspace.id,
            destinationChildIds[1]!,
          ).revisionNumber,
          parentDocumentId: branchRootId,
        },
      ), "NOT_FOUND");
      expectServiceError(
        () => restoreTrashedDocument(database, workspace.id, actor, childIds[2]!),
        "NOT_FOUND",
      );
      expect(treeSnapshot(database, workspace.id)).toEqual(parentTrashedSnapshot);

      restoreTrashedDocument(database, workspace.id, actor, branchRootId);
      for (const [parentId, expectedOrder] of internalOrderBeforeTrash) {
        expect(activeChildIds(database, workspace.id, parentId)).toEqual(expectedOrder);
      }
      assertTreeInvariants(database, workspace.id);
    },
  );

  it.each([0x10203040, 0x55667788, 0xdeadbeef])(
    "restores a middle sibling into a unique deterministic slot after survivors reorder (seed %i)",
    (seed) => {
      const { database, workspace, actor } = fixture();
      const bootstrapRootIds = activeChildIds(database, workspace.id, null);
      const roots = Array.from({ length: 6 }, (_, index) => createDocument(
        database,
        workspace.id,
        actor,
        {
          title: `${index === 2 ? "zz-restored" : "aa-active"}-${seed}-${index}`,
          content: content(`root-${index}`),
        },
      ).document.id);
      const restoredId = roots[2]!;
      archiveDocument(database, workspace.id, actor, restoredId, {
        baseRevision: getDocument(database, workspace.id, restoredId).revisionNumber,
      });

      reorderDocumentTree(database, workspace.id, actor, roots[5]!, {
        targetDocumentId: roots[1]!,
        position: "after",
      });
      expect(activeChildIds(database, workspace.id, null)).toEqual([
        ...bootstrapRootIds,
        roots[0],
        roots[1],
        roots[5],
        roots[3],
        roots[4],
      ]);

      restoreTrashedDocument(database, workspace.id, actor, restoredId);
      expect(activeChildIds(database, workspace.id, null)).toEqual([
        ...bootstrapRootIds,
        roots[0],
        roots[1],
        restoredId,
        roots[5],
        roots[3],
        roots[4],
      ]);
      assertTreeInvariants(database, workspace.id);
    },
  );
});
