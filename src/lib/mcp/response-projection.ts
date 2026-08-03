import { createHash } from "node:crypto";
import { z } from "zod";
import { getDocumentOutline } from "@/lib/documents/sections";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";

export const MCP_RESPONSE_MODES = ["summary", "outline", "full"] as const;
export type McpResponseMode = (typeof MCP_RESPONSE_MODES)[number];
export const mcpResponseModeSchema = z.enum(MCP_RESPONSE_MODES).default("summary");

export type McpMutationReceiptContext = {
  operation: string;
  actor: {
    type: "agent";
    principalId: string;
    source: "mcp";
  };
  requestId?: string;
  workspaceId?: string;
  documentId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonemptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function receiptRecords(payload: Record<string, unknown>) {
  const childKeys = [
    "document",
    "workingDocument",
    "committedRevision",
    "revision",
    "task",
    "assignment",
    "presence",
    "view",
  ];
  return [
    payload,
    ...childKeys
      .map((key) => payload[key])
      .filter(isRecord),
  ];
}

function firstString(
  records: Record<string, unknown>[],
  keys: string[],
) {
  for (const record of records) {
    for (const key of keys) {
      const value = nonemptyString(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function firstPositiveInteger(
  records: Record<string, unknown>[],
  keys: string[],
) {
  for (const record of records) {
    for (const key of keys) {
      const value = positiveInteger(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

type DraftStateProjection = {
  generation: number;
  draftVersion: number;
  committedDraftVersion: number;
  baseRevisionNumber: number;
  hasUncommittedChanges: boolean;
};

function draftStateProjection(value: unknown): DraftStateProjection | null {
  if (!isRecord(value)) return null;
  const generation = positiveInteger(value.generation);
  const draftVersion = nonnegativeInteger(value.draftVersion);
  const committedDraftVersion = nonnegativeInteger(value.committedDraftVersion);
  const baseRevisionNumber = positiveInteger(value.baseRevisionNumber);
  if (
    generation === null
    || draftVersion === null
    || committedDraftVersion === null
    || baseRevisionNumber === null
    || typeof value.hasUncommittedChanges !== "boolean"
  ) return null;
  return {
    generation,
    draftVersion,
    committedDraftVersion,
    baseRevisionNumber,
    hasUncommittedChanges: value.hasUncommittedChanges,
  };
}

export function draftMutationFields(payload: Record<string, unknown>) {
  if (!isRecord(payload.mutationState)) return null;
  const receipt = draftStateProjection(payload.mutationState.receipt);
  const current = draftStateProjection(payload.mutationState.current);
  if (
    payload.mutationState.source !== "working"
    || typeof payload.mutationState.replayed !== "boolean"
    || !receipt
    || !current
  ) return null;
  return {
    source: "working" as const,
    replayed: payload.mutationState.replayed,
    receiptGeneration: receipt.generation,
    currentGeneration: current.generation,
    receiptDraftVersion: receipt.draftVersion,
    currentDraftVersion: current.draftVersion,
    receiptCommittedDraftVersion: receipt.committedDraftVersion,
    currentCommittedDraftVersion: current.committedDraftVersion,
    receiptBaseRevisionNumber: receipt.baseRevisionNumber,
    currentBaseRevisionNumber: current.baseRevisionNumber,
    receiptHasUncommittedChanges: receipt.hasUncommittedChanges,
    currentHasUncommittedChanges: current.hasUncommittedChanges,
  };
}

/**
 * Build the durable machine receipt shared by every successful MCP mutation.
 *
 * Only identifiers present in the mutation input or result are projected. In
 * particular, this function never synthesizes a revision or draft identity for
 * operations that did not create or touch one.
 */
export function buildMcpMutationReceipt(
  payload: Record<string, unknown>,
  context: McpMutationReceiptContext,
) {
  const records = receiptRecords(payload);
  const mutationFields = draftMutationFields(payload);
  const draftFields = mutationFields
    ? {
        source: mutationFields.source,
        replayed: mutationFields.replayed,
        generation: mutationFields.receiptGeneration,
        currentGeneration: mutationFields.currentGeneration,
        draftVersion: mutationFields.receiptDraftVersion,
        receiptDraftVersion: mutationFields.receiptDraftVersion,
        currentDraftVersion: mutationFields.currentDraftVersion,
        committedDraftVersion: mutationFields.receiptCommittedDraftVersion,
        currentCommittedDraftVersion: mutationFields.currentCommittedDraftVersion,
        baseRevisionNumber: mutationFields.receiptBaseRevisionNumber,
        currentBaseRevisionNumber: mutationFields.currentBaseRevisionNumber,
        hasUncommittedChanges: mutationFields.receiptHasUncommittedChanges,
        currentHasUncommittedChanges: mutationFields.currentHasUncommittedChanges,
      }
    : canonicalDraftFields(payload);
  const workspaceId = firstString(records, ["workspaceId"])
    ?? context.workspaceId
    ?? null;
  const documentId = firstString(records, [
    "documentId",
    "resultDocumentId",
    "targetDocumentId",
  ])
    ?? (isRecord(payload.document) ? nonemptyString(payload.document.id) : null)
    ?? context.documentId
    ?? null;
  const revisionId = firstString(records, ["revisionId"])
    ?? (isRecord(payload.committedRevision)
      ? nonemptyString(payload.committedRevision.id)
      : null);
  const revisionNumber = firstPositiveInteger(records, [
    "revisionNumber",
    "resultRevisionNumber",
    "number",
  ]);
  const generation = mutationFields?.receiptGeneration
    ?? firstPositiveInteger(records, ["generation"]);

  return {
    version: "1",
    operation: context.operation,
    actor: context.actor,
    ...(workspaceId ? { workspaceId } : {}),
    ...(documentId ? { documentId } : {}),
    ...(revisionId ? { revisionId } : {}),
    ...(revisionNumber !== null ? { revisionNumber } : {}),
    ...(generation !== null ? { generation } : {}),
    ...draftFields,
    ...(context.requestId
      ? {
        requestId: context.requestId,
        idempotency: {
          requestId: context.requestId,
          ...(mutationFields ? { replayed: mutationFields.replayed } : {}),
        },
      }
      : {}),
  };
}

export function canonicalDraftFields(payload: Record<string, unknown>) {
  const mutationFields = draftMutationFields(payload);
  if (mutationFields) {
    return {
      source: mutationFields.source,
      replayed: mutationFields.replayed,
      generation: mutationFields.currentGeneration,
      receiptGeneration: mutationFields.receiptGeneration,
      currentGeneration: mutationFields.currentGeneration,
      draftVersion: mutationFields.currentDraftVersion,
      receiptDraftVersion: mutationFields.receiptDraftVersion,
      currentDraftVersion: mutationFields.currentDraftVersion,
      committedDraftVersion: mutationFields.currentCommittedDraftVersion,
      receiptCommittedDraftVersion: mutationFields.receiptCommittedDraftVersion,
      currentCommittedDraftVersion: mutationFields.currentCommittedDraftVersion,
      baseRevisionNumber: mutationFields.currentBaseRevisionNumber,
      receiptBaseRevisionNumber: mutationFields.receiptBaseRevisionNumber,
      currentBaseRevisionNumber: mutationFields.currentBaseRevisionNumber,
      hasUncommittedChanges: mutationFields.currentHasUncommittedChanges,
      receiptHasUncommittedChanges: mutationFields.receiptHasUncommittedChanges,
      currentHasUncommittedChanges: mutationFields.currentHasUncommittedChanges,
    };
  }
  const workingDocument = isRecord(payload.workingDocument)
    ? payload.workingDocument
    : null;
  const document = isRecord(payload.document) ? payload.document : null;
  const sources = [payload, workingDocument, document].filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  const draftVersion = sources
    .map((source) => nonnegativeInteger(source.draftVersion))
    .find((value) => value !== null)
    ?? nonnegativeInteger(payload.currentDraftVersion);
  if (draftVersion === null) return {};

  const baseRevisionNumber = sources
    .map((source) => nonnegativeInteger(source.baseRevisionNumber))
    .find((value) => value !== null);
  const hasUncommittedChanges = sources
    .map((source) => source.hasUncommittedChanges)
    .find((value) => typeof value === "boolean");
  const committedDraftVersion = sources
    .map((source) => nonnegativeInteger(source.committedDraftVersion))
    .find((value) => value !== null);

  return {
    draftVersion,
    ...(baseRevisionNumber === undefined || baseRevisionNumber === null
      ? {}
      : { baseRevisionNumber }),
    ...(typeof hasUncommittedChanges === "boolean"
      ? { hasUncommittedChanges }
      : {}),
    ...(committedDraftVersion === undefined || committedDraftVersion === null
      ? {}
      : { committedDraftVersion }),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

export function mcpContentDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function isDocumentContent(value: unknown): value is NyxdocDocumentV2 {
  return isRecord(value)
    && value.schemaVersion === 2
    && Array.isArray(value.blocks);
}

function findDocumentContent(value: Record<string, unknown>) {
  const candidates = [
    value.content,
    isRecord(value.document) ? value.document.content : null,
    isRecord(value.workingDocument) ? value.workingDocument.content : null,
  ];
  return candidates.find(isDocumentContent) ?? null;
}

function contentSummary(content: NyxdocDocumentV2) {
  return {
    schemaVersion: content.schemaVersion,
    blockCount: content.blocks.length,
    contentDigest: mcpContentDigest(content),
  };
}

function projectCompactValue(
  value: unknown,
  path: string,
  omittedFields: Set<string>,
): unknown {
  if (isDocumentContent(value)) {
    omittedFields.add(`${path}.blocks`);
    return contentSummary(value);
  }
  if (typeof value === "string" && ["markdown", "json", "yjsState"].includes(path.split(".").at(-1) ?? "")) {
    omittedFields.add(path);
    return {
      characterCount: value.length,
      contentDigest: mcpContentDigest(value),
    };
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => projectCompactValue(child, `${path}[${index}]`, omittedFields));
  }
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      projectCompactValue(child, path ? `${path}.${key}` : key, omittedFields),
    ]),
  );
}

export function projectMutationResponse(
  operation: string,
  payload: Record<string, unknown>,
  responseMode: McpResponseMode,
) {
  const omittedFields = new Set<string>();
  const content = findDocumentContent(payload);
  const projected = responseMode === "full"
    ? structuredClone(payload)
    : projectCompactValue(payload, "", omittedFields) as Record<string, unknown>;
  const metrics = content ? contentSummary(content) : null;
  const result: Record<string, unknown> = {
    resultVersion: "1",
    operation,
    responseMode,
    ...projected,
    ...canonicalDraftFields(payload),
    ...(metrics ? {
      blockCount: metrics.blockCount,
      contentDigest: metrics.contentDigest,
    } : {}),
  };

  if (responseMode === "outline" && content) {
    result.outline = getDocumentOutline(content).map((section) => ({
      sectionId: section.sectionId,
      level: section.level,
      title: section.title,
      parentSectionId: section.parentSectionId,
      sectionHash: section.sectionHash,
    }));
  }

  result.response = {
    mode: responseMode,
    omittedFields: [...omittedFields].sort(),
    estimatedBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
  };
  return result;
}
