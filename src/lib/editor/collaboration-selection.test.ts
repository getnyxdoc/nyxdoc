import { describe, expect, it } from "vitest";
import {
  BaseParagraphPlugin,
  createSlateEditor,
  type Value,
} from "platejs";
import { BaseYjsPlugin, type UnifiedProvider } from "@platejs/yjs";
import {
  YjsEditor,
  slateNodesToInsertDelta,
  yTextToSlateElement,
} from "@slate-yjs/core";
import * as Y from "yjs";
import {
  CollaborativeNodeIdPlugin,
  shouldAssignCollaborativeNodeId,
} from "@/lib/editor/collaborative-node-ids";

function createTestProvider(ydoc: Y.Doc): UnifiedProvider {
  return {
    awareness: undefined as never,
    document: ydoc,
    type: "memory",
    isConnected: false,
    isSynced: true,
    isConnectionPending: false,
    isSyncPending: false,
    isLocalPersistence: false,
    connect() {
      this.isConnected = true;
    },
    disconnect() {
      this.isConnected = false;
    },
    destroy() {
      this.isConnected = false;
    },
  };
}

async function createCollaborativeEditor(value: Value) {
  const ydoc = new Y.Doc();
  const plugin = BaseYjsPlugin.configure({
    options: {
      ydoc,
      providers: [createTestProvider(ydoc)],
    },
  });
  const editor = createSlateEditor({
    plugins: [BaseParagraphPlugin, plugin, CollaborativeNodeIdPlugin],
    value: [],
    skipInitialization: true,
    nodeId: {
      filter: () => shouldAssignCollaborativeNodeId(),
      idCreator: () => globalThis.crypto.randomUUID(),
      reuseId: true,
    },
  });

  await editor.getApi(BaseYjsPlugin).yjs.init({
    id: "collaboration-selection-test",
    autoConnect: false,
    value,
  });

  return { editor, ydoc };
}

function elementIds(value: unknown) {
  const ids: string[] = [];
  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    const element = node as { id?: unknown; children?: unknown[] };
    if (Array.isArray(element.children)) {
      if (typeof element.id === "string") ids.push(element.id);
      element.children.forEach(visit);
    }
  }
  if (Array.isArray(value)) value.forEach(visit);
  return ids;
}

describe("collaborative editor selection", () => {
  it("keeps the caret in the new paragraph after Enter at the first paragraph end", async () => {
    const { editor, ydoc } = await createCollaborativeEditor([
      {
        id: "first",
        type: "p",
        children: [{ text: "첫 문단" }],
      },
      {
        id: "second",
        type: "p",
        children: [{ text: "둘째 문단" }],
      },
    ]);

    editor.tf.select({ path: [0, 0], offset: 4 });
    editor.tf.insertBreak();
    YjsEditor.flushLocalChanges(editor as never);

    expect(editor.children).toHaveLength(3);
    expect(editor.selection).toEqual({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
    const sharedValue = yTextToSlateElement(
      ydoc.get("content", Y.XmlText),
    ).children;
    const sharedIds = sharedValue.map((node) => (node as { id?: unknown }).id);
    expect(sharedIds).toEqual([
      "first",
      expect.not.stringMatching(/^first$/),
      "second",
    ]);
    expect(editor.children.map((node) => (node as { id?: unknown }).id))
      .toEqual(sharedIds);

    editor.getApi(BaseYjsPlugin).yjs.destroy();
    ydoc.destroy();
  });

  it("assigns unique IDs before Yjs stores an inserted block tree", async () => {
    const { editor, ydoc } = await createCollaborativeEditor([
      {
        id: "first",
        type: "p",
        children: [{ text: "기존 문단" }],
      },
    ]);

    editor.tf.insertNodes({
      id: "first",
      type: "table",
      children: [
        {
          type: "tr",
          children: [
            {
              type: "td",
              children: [
                {
                  type: "p",
                  children: [{ text: "새 셀" }],
                },
              ],
            },
          ],
        },
      ],
    }, { at: [1], select: true });
    YjsEditor.flushLocalChanges(editor as never);

    const sharedValue = yTextToSlateElement(
      ydoc.get("content", Y.XmlText),
    ).children;
    const ids = elementIds(sharedValue);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("first");
    expect(ids.slice(1)).not.toContain("first");

    editor.getApi(BaseYjsPlugin).yjs.destroy();
    ydoc.destroy();
  });

  it("preserves stable IDs when an agent-style remote replacement arrives", async () => {
    const { editor, ydoc } = await createCollaborativeEditor([
      {
        id: "first",
        type: "p",
        children: [{ text: "첫 문단" }],
      },
      {
        id: "second",
        type: "p",
        children: [{ text: "둘째 문단" }],
      },
    ]);
    const beforeIds = elementIds(editor.children);
    const replacement = structuredClone(editor.children) as Array<{
      id: string;
      type: string;
      children: Array<{ text: string }>;
    }>;
    replacement[1].children = [{ text: "에이전트가 바꾼 둘째 문단" }];

    const shared = ydoc.get("content", Y.XmlText);
    ydoc.transact(() => {
      shared.delete(0, shared.length);
      shared.applyDelta(slateNodesToInsertDelta(replacement as never));
    }, "agent-remote-replacement");

    expect(elementIds(editor.children)).toEqual(beforeIds);
    expect(yTextToSlateElement(shared).children).toEqual(replacement);

    editor.getApi(BaseYjsPlugin).yjs.destroy();
    ydoc.destroy();
  });
});
