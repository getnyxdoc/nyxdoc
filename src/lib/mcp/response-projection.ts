import { createHash } from "node:crypto";
import { z } from "zod";
import { getDocumentOutline } from "@/lib/documents/sections";
import type { NyxdocDocumentV2 } from "@/lib/editor/schema";

export const MCP_RESPONSE_MODES = ["summary", "outline", "full"] as const;
export type McpResponseMode = (typeof MCP_RESPONSE_MODES)[number];
export const mcpResponseModeSchema = z.enum(MCP_RESPONSE_MODES).default("summary");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function canonicalDraftFields(payload: Record<string, unknown>) {
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
