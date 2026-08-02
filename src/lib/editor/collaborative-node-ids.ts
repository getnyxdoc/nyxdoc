import {
  NodeApi,
  createSlatePlugin,
  type SlateEditor,
  type TElement,
} from "platejs";
import { YjsEditor } from "@slate-yjs/core";

type ElementLike = TElement & {
  id?: unknown;
  children: unknown[];
};

let remoteYjsApplyDepth = 0;

export function shouldAssignCollaborativeNodeId() {
  return remoteYjsApplyDepth === 0;
}

function isElementLike(value: unknown): value is ElementLike {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray((value as { children?: unknown }).children),
  );
}

function editorContainsId(editor: SlateEditor, id: string) {
  return editor.api.some({
    at: [],
    match: (node) => isElementLike(node) && node.id === id,
  });
}

function prepareInsertedNodeIds(editor: SlateEditor, input: unknown) {
  const node = structuredClone(input);
  const insertedIds = new Set<string>();

  function visit(value: unknown) {
    if (!isElementLike(value)) return;

    if (editor.api.isBlock(value)) {
      const currentId = typeof value.id === "string" ? value.id : "";
      if (
        !currentId
        || insertedIds.has(currentId)
        || editorContainsId(editor, currentId)
      ) {
        value.id = globalThis.crypto.randomUUID();
      }
      insertedIds.add(value.id as string);
    }

    value.children.forEach(visit);
  }

  visit(node);
  return node;
}

/**
 * Keep local insert/split IDs stable before Yjs stores them, while allowing a
 * remote Yjs replacement to reuse the canonical IDs already present in that
 * update. Plate's core NodeIdPlugin otherwise mistakes those remote nodes for
 * local duplicates while the old tree is being removed.
 */
export const CollaborativeNodeIdPlugin = createSlatePlugin({
  key: "nyxdoc-collaborative-node-ids",
}).overrideEditor(({ editor, tf: { apply } }) => {
  if (YjsEditor.isYjsEditor(editor)) {
    const applyRemoteEvents = editor.applyRemoteEvents;
    editor.applyRemoteEvents = (events, origin) => {
      remoteYjsApplyDepth += 1;
      try {
        applyRemoteEvents(events, origin);
      } finally {
        remoteYjsApplyDepth -= 1;
      }
    };
  }

  return {
    transforms: {
      apply(operation) {
        const localOperation = !YjsEditor.isYjsEditor(editor) || YjsEditor.isLocal(editor);
        if (operation.type === "insert_node" && localOperation) {
          return apply({
            ...operation,
            node: prepareInsertedNodeIds(editor, operation.node) as typeof operation.node,
          });
        }

        if (operation.type === "split_node" && localOperation) {
          const target = NodeApi.get(editor, operation.path);
          if (isElementLike(target) && editor.api.isBlock(target)) {
            return apply({
              ...operation,
              properties: {
                ...operation.properties,
                id: globalThis.crypto.randomUUID(),
              },
            });
          }
        }

        return apply(operation);
      },
    },
  };
});
