"use client";

import { useEffect, useMemo, useState } from "react";
import type { UnifiedProvider } from "@platejs/yjs";
import {
  slateNodesToInsertDelta,
  yTextToSlateElement,
} from "@slate-yjs/core";
import * as Y from "yjs";
import {
  NyxdocRichEditor,
  type NyxdocEditorCollaboration,
} from "@/components/editor/editor-lab";
import { repairDocumentNodeIds } from "@/lib/editor/node-ids";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";

const collaborationTableRows = Array.from({ length: 5 }, (_, rowIndex) => ({
  id: `collaboration-e2e-row-${rowIndex}`,
  type: "tr" as const,
  children: Array.from({ length: 5 }, (_, columnIndex) => ({
    id: `collaboration-e2e-cell-${rowIndex}-${columnIndex}`,
    type: rowIndex === 0 ? "th" as const : "td" as const,
    children: [{
      id: `collaboration-e2e-cell-p-${rowIndex}-${columnIndex}`,
      type: "p" as const,
      children: [{ text: `R${rowIndex}C${columnIndex}` }],
    }],
  })),
}));

const initialDocument: NyxdocDocumentV2 = {
  schemaVersion: 2 as const,
  blocks: [
    {
      id: "collaboration-e2e-first",
      type: "p" as const,
      children: [{ text: "첫 문단" }],
    },
    {
      id: "collaboration-e2e-second",
      type: "p" as const,
      children: [{ text: "둘째 문단" }],
    },
    {
      id: "collaboration-e2e-agent-link",
      type: "p" as const,
      children: [{
        id: "collaboration-e2e-agent-link-inline",
        type: "a" as const,
        url: "https://learn.chatgpt.com/docs/build-skills",
        children: [{ text: "https://learn.chatgpt.com/docs/build-skills" }],
      }],
    },
    {
      id: "collaboration-e2e-table",
      type: "table",
      colSizes: [180, 180, 180, 180, 180],
      children: collaborationTableRows,
    },
    {
      id: "collaboration-e2e-after-table",
      type: "p",
      children: [{ text: "표 다음 문단" }],
    },
  ],
};

const performanceBlocks = Array.from({ length: 945 }, (_, index) => ({
  id: `collaboration-performance-${index}`,
  type: "p" as const,
  children: [{
    text: `PERF-BLOCK-${String(index + 1).padStart(4, "0")} `
      + "대용량 문서 편집 성능 측정 문장입니다. ".repeat(5),
  }],
}));

function memoryProvider(ydoc: Y.Doc): UnifiedProvider {
  return {
    awareness: undefined as never,
    document: ydoc,
    type: "memory",
    isConnected: false,
    isSynced: true,
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

export function CollaborationE2EClient() {
  const [ready, setReady] = useState(false);
  const [repairCount, setRepairCount] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  const [ydocUpdateCount, setYdocUpdateCount] = useState(0);
  const ydoc = useMemo(() => new Y.Doc(), []);
  const provider = useMemo(() => memoryProvider(ydoc), [ydoc]);
  const collaboration = useMemo<NyxdocEditorCollaboration>(() => ({
    ydoc,
    roomName: "collaboration-e2e",
    publicUrl: "",
    providers: [provider],
    autoConnect: false,
    initialValue: initialDocument.blocks,
    user: {
      id: "collaboration-e2e-user",
      name: "Collaboration E2E",
      avatarUrl: null,
      color: "#3b9977",
    },
    getToken: async () => "",
    onReady: () => setReady(true),
  }), [provider, ydoc]);

  useEffect(() => {
    const sharedContent = ydoc.get("content", Y.XmlText);
    const detectAndRepairSharedIds = (_update: Uint8Array, origin: unknown) => {
      setYdocUpdateCount((count) => count + 1);
      if (origin === "collaboration-e2e-server-repair") return;
      const slateRoot = yTextToSlateElement(sharedContent);
      const repaired = repairDocumentNodeIds(
        slateRoot.children,
        () => globalThis.crypto.randomUUID(),
      );
      if (repaired.repairs.length === 0) return;

      setRepairCount((count) => count + repaired.repairs.length);
      ydoc.transact(() => {
        sharedContent.delete(0, sharedContent.length);
        sharedContent.applyDelta(slateNodesToInsertDelta(repaired.value as never));
      }, "collaboration-e2e-server-repair");
    };
    ydoc.on("update", detectAndRepairSharedIds);
    return () => {
      ydoc.off("update", detectAndRepairSharedIds);
      ydoc.destroy();
    };
  }, [ydoc]);

  return (
    <>
      <output data-testid="collaboration-ready" hidden>
        {ready ? "ready" : "connecting"}
      </output>
      <output data-testid="collaboration-repair-count" hidden>
        {repairCount}
      </output>
      <output data-testid="collaboration-change-count" hidden>
        {changeCount}
      </output>
      <output data-testid="collaboration-ydoc-update-count" hidden>
        {ydocUpdateCount}
      </output>
      <button
        data-testid="collaboration-remote-replace"
        hidden
        type="button"
        onClick={() => {
          const sharedContent = ydoc.get("content", Y.XmlText);
          const slateRoot = yTextToSlateElement(sharedContent) as unknown as {
            children: NyxdocDocumentV2["blocks"];
          };
          const blocks = structuredClone(slateRoot.children);
          const lastBlock = blocks.at(-1);
          if (lastBlock?.type === "p") {
            lastBlock.children = [{ text: "표 다음 문단 · 원격 갱신" }];
          }
          ydoc.transact(() => {
            sharedContent.delete(0, sharedContent.length);
            sharedContent.applyDelta(slateNodesToInsertDelta(blocks as never));
          }, "collaboration-e2e-remote-replace");
        }}
      >
        remote replace
      </button>
      <button
        data-testid="collaboration-remote-link"
        hidden
        type="button"
        onClick={() => {
          const sharedContent = ydoc.get("content", Y.XmlText);
          const slateRoot = yTextToSlateElement(sharedContent) as unknown as {
            children: NyxdocDocumentV2["blocks"];
          };
          const blocks = structuredClone(slateRoot.children);
          blocks.push({
            id: "collaboration-e2e-remote-link",
            type: "p",
            children: [{
              id: "collaboration-e2e-remote-link-inline",
              type: "a",
              url: "https://example.com/agent-link",
              children: [{ text: "https://example.com/agent-link" }],
            }],
          });
          ydoc.transact(() => {
            sharedContent.delete(0, sharedContent.length);
            sharedContent.applyDelta(slateNodesToInsertDelta(blocks as never));
          }, "collaboration-e2e-remote-link");
        }}
      >
        remote link
      </button>
      <button
        data-testid="collaboration-load-performance-document"
        hidden
        type="button"
        onClick={() => {
          const sharedContent = ydoc.get("content", Y.XmlText);
          ydoc.transact(() => {
            sharedContent.delete(0, sharedContent.length);
            sharedContent.applyDelta(slateNodesToInsertDelta(performanceBlocks as never));
          }, "collaboration-e2e-performance");
        }}
      >
        load performance document
      </button>
      <NyxdocRichEditor
        ariaLabel="협업 선택 테스트"
        documentId="collaboration-e2e-document"
        initialDocument={initialDocument}
        collaboration={collaboration}
        onChange={() => setChangeCount((count) => count + 1)}
        workspaceId="workspace-e2e"
      />
    </>
  );
}
