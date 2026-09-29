import { type McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeParseAsync } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type McpProfile = "full" | "compact";

export const compactInstructions = [
  "Nyxdoc stores shared documents, drafts, revisions and agent tasks.",
  "Use nyxdoc_discover to find an operation, then inspect it by operation name for its inputSchema and workflow before calling the indicated tool with {operation,args}.",
  "Discover only what the current task needs. Start with list_agent_workspaces when choosing a workspace.",
  "All original permissions apply. Never bypass denials through a browser or another credential.",
  "Connecting or discovering does not authorize task execution. Writes require user intent; committing a reviewed draft is explicit.",
].join(" ");

type Route = "nyxdoc_read" | "nyxdoc_write" | "nyxdoc_destructive";

function route(tool: RegisteredTool): Route {
  if (tool.annotations?.readOnlyHint === true) return "nyxdoc_read";
  return tool.annotations?.destructiveHint === false ? "nyxdoc_write" : "nyxdoc_destructive";
}

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function failure(code: string, message: string): CallToolResult {
  return { ...result({ code, error: message }), isError: true };
}

function workflow(name: string, tool: RegisteredTool) {
  const guidance = [
    "Use returned IDs and webUrl exactly. Document/task IDs resolve their workspace; pass workspaceId for ambiguous list/search/create operations.",
    "Credentials and document content are private. Scope and permission denials must not be bypassed.",
  ];
  if (/document|revision|handoff|image|backlink|search/.test(name)) {
    guidance.push(
      "For prose: search_documents/get_document_outline -> get_document_markdown for one section -> patch_document_markdown dryRun -> reviewed patch and explicit commit. Inspect each operation before first use.",
      "get_document reads the canonical revision; get_working_document reads the shared draft. Read tools never change draftVersion. Use top-level draftVersion and sectionHash from the latest read; only hasUncommittedChanges indicates pending changes.",
      "AST tools need get_schema only when constructing AST/patch input. Preserve stable node IDs. The page title is separate metadata; do not repeat it as a leading body heading.",
    );
  }
  if (tool.annotations?.readOnlyHint !== true) {
    guidance.push(
      "Use a unique requestId for each intent and reuse it only for retries of the same request. Use expectedDraftVersion/sectionHash from your read. On conflict, re-read instead of overwriting.",
      "Draft edits do not commit. Review the result, then explicitly commit_document or use an explicit patch_document_markdown.commit. New document creation creates revision 1. Prefer summary responses.",
    );
  }
  if (/task|assignment|my_work|workspace_context|presence/.test(name)) {
    guidance.push(
      "Read workspace context and ongoing assignments before work. Agent To-dos are separate finite tasks; list_my_tasks spans allowed workspaces. Only claim and execute a task when a human explicitly requested it, never merely because it was listed.",
      "Use report_task for progress/blockers and complete_task with the result revision for human review. Assignments and presence do not grant access.",
    );
  }
  if (/image/.test(name)) guidance.push("Use create_image_upload, PUT raw bytes to the returned one-time URL with its Authorization header, then insert imageBlock. Never embed base64 in a document.");
  if (/handoff/.test(name)) guidance.push("Capture conversations only when explicitly requested. Use dryRun when the destination or task decomposition is uncertain.");
  if (/admin/.test(name)) guidance.push("Management operations only propose requests for human approval; agents cannot approve requests or elevate their access.");
  return guidance;
}

/** Reuse the actual registered schemas and guarded handlers: no second permission or write path. */
export function installCompactTools(server: McpServer, operations: Map<string, RegisteredTool>) {
  for (const tool of operations.values()) tool.remove();

  server.registerTool("nyxdoc_discover", {
    description: "Find Nyxdoc operations by query; pass an exact operation to read its inputSchema and workflow. Returns only requested definitions.",
    inputSchema: {
      query: z.string().max(200).optional(),
      operation: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(10).default(5),
      offset: z.number().int().min(0).max(1000).default(0),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ query, operation, limit, offset }) => {
    if (operation) {
      const tool = operations.get(operation);
      if (!tool) return failure("UNKNOWN_OPERATION", "Operation not found. Search with nyxdoc_discover first.");
      return result({
        operation, tool: route(tool), description: tool.description,
        inputSchema: tool.inputSchema ? toJsonSchemaCompat(tool.inputSchema, { strictUnions: true, pipeStrategy: "input" }) : { type: "object", properties: {} },
        annotations: tool.annotations, workflow: workflow(operation, tool),
      });
    }
    const terms = (query ?? "").toLowerCase().split(/[\s_]+/).filter(Boolean);
    const ranked = [...operations].map(([name, tool], index) => {
      const text = `${name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 3 : text.includes(term) ? 1 : 0), 0);
      return { name, tool, score, index };
    }).filter(item => !terms.length || item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    return result({
      operations: ranked.slice(offset, offset + limit).map(({ name, tool }) => ({
        operation: name, tool: route(tool), description: (tool.description ?? tool.title ?? name).slice(0, 180),
      })),
      total: ranked.length,
      nextOffset: offset + limit < ranked.length ? offset + limit : null,
      next: "Inspect one operation with nyxdoc_discover({operation}) before calling it. Search uses English operation names/descriptions.",
    });
  });

  for (const name of ["nyxdoc_read", "nyxdoc_write", "nyxdoc_destructive"] as const) {
    server.registerTool(name, {
      description: name === "nyxdoc_read"
        ? "Run a discovered read-only Nyxdoc operation with its validated args."
        : name === "nyxdoc_write"
          ? "Run a discovered Nyxdoc write with its validated args and original permission/conflict checks. Commit only when explicitly intended."
          : "Run a discovered destructive Nyxdoc operation (trash, restore or delete). Requires explicit intent; original permission checks apply.",
      inputSchema: { operation: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).default({}) },
      annotations: { readOnlyHint: name === "nyxdoc_read", destructiveHint: name === "nyxdoc_destructive", openWorldHint: false },
    }, async ({ operation, args }, extra) => {
      const tool = operations.get(operation);
      if (!tool) return failure("UNKNOWN_OPERATION", "Operation not found. Search with nyxdoc_discover first.");
      if (route(tool) !== name) return failure("WRONG_TOOL", `Use ${route(tool)} for this operation.`);
      const parsed = tool.inputSchema ? await safeParseAsync(tool.inputSchema, args) : { success: true as const, data: args };
      if (!parsed.success) {
        // Do not echo user input (which can contain private document data) in validation errors.
        return failure("INVALID_INPUT", "Arguments do not match this operation's schema. Inspect the operation with nyxdoc_discover.");
      }
      return await (tool.handler as ToolCallback<z.ZodRawShape>)(parsed.data as Record<string, unknown>, extra);
    });
  }
}
