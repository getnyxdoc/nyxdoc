import { createHash } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import type { NyxdocBlock, NyxdocDocumentV2 } from "@/lib/editor/schema";

/**
 * A top-level AST node ID belongs to a document-local public namespace.
 * `path` is a JSON Pointer into the submitted AST, so callers can safely
 * substitute `effectiveId` in a follow-up patch without guessing which node
 * the server changed.
 */
export type TopLevelBlockIdRemap = {
  path: `/blocks/${number}/id`;
  requestedId: string | null;
  effectiveId: string;
  reason: "missing" | "duplicate_in_document" | "cross_document_collision";
};

export type BlockIdNormalization = {
  /** Public node identity is always scoped by (documentId, nodeId). */
  identityScope: "documentId+nodeId";
  remappedTopLevelBlockIds: number;
  remaps: TopLevelBlockIdRemap[];
};

export function blockIdNormalization(
  remaps: readonly TopLevelBlockIdRemap[],
): BlockIdNormalization | undefined {
  if (remaps.length === 0) return undefined;
  return {
    identityScope: "documentId+nodeId",
    remappedTopLevelBlockIds: remaps.length,
    remaps: [...remaps],
  };
}

function namespacedBlockId(input: {
  documentId: string;
  blockIndex: number;
  previousId: string | null;
  attempt: number;
}) {
  const digest = createHash("sha256")
    .update([
      input.documentId,
      String(input.blockIndex),
      input.previousId ?? "<missing>",
      String(input.attempt),
    ].join("\u0000"))
    .digest("hex");
  return `nyxdoc-block-${digest}`;
}

/**
 * document_blocks.id is a storage-wide key, while AST node IDs are authored in
 * a document-local context. External agents commonly use readable IDs such as
 * "title" in more than one document. Keep those IDs when possible and
 * deterministically namespace only missing or storage-conflicting top-level
 * IDs before the draft reaches the canonical block table.
 */
export function normalizeTopLevelBlockIds(
  database: NyxDatabase,
  documentId: string,
  content: NyxdocDocumentV2,
) {
  const ownerById = database.prepare(
    "SELECT document_id FROM document_blocks WHERE id = ?",
  );
  const seen = new Set<string>();
  const repairs: TopLevelBlockIdRemap[] = [];
  let nextBlocks: NyxdocBlock[] | null = null;

  function ownerDocumentId(blockId: string) {
    return (ownerById.get(blockId) as { document_id: string } | undefined)
      ?.document_id ?? null;
  }

  for (const [blockIndex, block] of content.blocks.entries()) {
    const previousId = typeof block.id === "string" && block.id.length > 0
      ? block.id
      : null;
    const owner = previousId ? ownerDocumentId(previousId) : null;
    const duplicateInDocument = previousId !== null && seen.has(previousId);
    const canKeep = previousId !== null
      && !duplicateInDocument
      && (owner === null || owner === documentId);

    if (canKeep) {
      seen.add(previousId);
      continue;
    }

    let nextId: string | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = namespacedBlockId({
        documentId,
        blockIndex,
        previousId,
        attempt,
      });
      const candidateOwner = ownerDocumentId(candidate);
      if (!seen.has(candidate) && (candidateOwner === null || candidateOwner === documentId)) {
        nextId = candidate;
        break;
      }
    }
    if (!nextId) {
      throw new Error("문서별 고유 블록 ID를 만들지 못했습니다.");
    }

    nextBlocks ??= structuredClone(content.blocks) as NyxdocBlock[];
    nextBlocks[blockIndex] = { ...nextBlocks[blockIndex], id: nextId };
    repairs.push({
      path: `/blocks/${blockIndex}/id`,
      requestedId: previousId,
      effectiveId: nextId,
      reason: previousId === null
        ? "missing"
        : duplicateInDocument
          ? "duplicate_in_document"
          : "cross_document_collision",
    });
    seen.add(nextId);
  }

  return {
    content: nextBlocks
      ? { ...content, blocks: nextBlocks }
      : content,
    repairs,
  };
}
