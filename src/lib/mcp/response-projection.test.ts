import { describe, expect, it } from "vitest";
import {
  buildMcpMutationReceipt,
  canonicalDraftFields,
  draftMutationFields,
  projectMutationResponse,
} from "@/lib/mcp/response-projection";

describe("MCP response projection", () => {
  it("promotes nested working-document state to the canonical top-level fields", () => {
    const payload = {
      workingDocument: {
        documentId: "document-1",
        draftVersion: 7,
        committedDraftVersion: 5,
        baseRevisionNumber: 3,
        hasUncommittedChanges: true,
      },
    };

    expect(canonicalDraftFields(payload)).toEqual({
      draftVersion: 7,
      committedDraftVersion: 5,
      baseRevisionNumber: 3,
      hasUncommittedChanges: true,
    });
    expect(projectMutationResponse("patch_document", payload, "summary")).toMatchObject({
      draftVersion: 7,
      baseRevisionNumber: 3,
      hasUncommittedChanges: true,
      workingDocument: {
        draftVersion: 7,
        committedDraftVersion: 5,
        baseRevisionNumber: 3,
        hasUncommittedChanges: true,
      },
    });
  });

  it("uses the observed current version for a Markdown dry-run response", () => {
    expect(projectMutationResponse("patch_document_markdown", {
      dryRun: true,
      currentDraftVersion: 11,
    }, "summary")).toMatchObject({
      draftVersion: 11,
      currentDraftVersion: 11,
    });
  });

  it("keeps an idempotent receipt distinct while promoting current draft state", () => {
    const payload = {
      workingDocument: {
        documentId: "document-1",
        generation: 2,
        draftVersion: 12,
        committedDraftVersion: 9,
        baseRevisionNumber: 4,
        hasUncommittedChanges: true,
      },
      mutationState: {
        source: "working",
        replayed: true,
        receipt: {
          generation: 2,
          draftVersion: 10,
          committedDraftVersion: 9,
          baseRevisionNumber: 4,
          hasUncommittedChanges: true,
        },
        current: {
          generation: 2,
          draftVersion: 12,
          committedDraftVersion: 9,
          baseRevisionNumber: 4,
          hasUncommittedChanges: true,
        },
      },
    };

    expect(draftMutationFields(payload)).toMatchObject({
      source: "working",
      replayed: true,
      receiptDraftVersion: 10,
      currentDraftVersion: 12,
    });
    expect(projectMutationResponse("update_document", payload, "summary")).toMatchObject({
      source: "working",
      replayed: true,
      draftVersion: 12,
      receiptDraftVersion: 10,
      currentDraftVersion: 12,
      workingDocument: { draftVersion: 12 },
    });
    expect(buildMcpMutationReceipt(payload, {
      operation: "update_document",
      actor: {
        type: "agent",
        principalId: "agent-principal-1",
        source: "mcp",
      },
      requestId: "replayed-update-001",
    })).toMatchObject({
      source: "working",
      replayed: true,
      generation: 2,
      draftVersion: 10,
      receiptDraftVersion: 10,
      currentDraftVersion: 12,
      baseRevisionNumber: 4,
      idempotency: {
        requestId: "replayed-update-001",
        replayed: true,
      },
    });
  });

  it("does not present a draft base revision as a newly written canonical revision", () => {
    const receipt = buildMcpMutationReceipt({
      workingDocument: {
        documentId: "document-1",
        generation: 1,
        draftVersion: 3,
        committedDraftVersion: 2,
        baseRevisionNumber: 7,
        hasUncommittedChanges: true,
      },
    }, {
      operation: "patch_document",
      actor: {
        type: "agent",
        principalId: "agent-principal-1",
        source: "mcp",
      },
    });

    expect(receipt).toMatchObject({ baseRevisionNumber: 7 });
    expect(receipt).not.toHaveProperty("revisionNumber");
  });

  it("builds an explicit write receipt only from identifiers present in the mutation", () => {
    const receipt = buildMcpMutationReceipt({
      workspaceId: "workspace-1",
      workingDocument: {
        documentId: "document-1",
        generation: 4,
        draftVersion: 7,
        committedDraftVersion: 7,
        baseRevisionNumber: 3,
        hasUncommittedChanges: false,
      },
      committedRevision: {
        id: "revision-3",
        number: 3,
      },
    }, {
      operation: "commit_document",
      actor: {
        type: "agent",
        principalId: "agent-principal-1",
        source: "mcp",
      },
      requestId: "commit-request-1",
    });

    expect(receipt).toEqual({
      version: "1",
      operation: "commit_document",
      actor: {
        type: "agent",
        principalId: "agent-principal-1",
        source: "mcp",
      },
      workspaceId: "workspace-1",
      documentId: "document-1",
      revisionId: "revision-3",
      revisionNumber: 3,
      generation: 4,
      draftVersion: 7,
      committedDraftVersion: 7,
      baseRevisionNumber: 3,
      hasUncommittedChanges: false,
      requestId: "commit-request-1",
      idempotency: { requestId: "commit-request-1" },
    });
  });

  it("does not invent document, revision, draft, or idempotency identifiers", () => {
    const receipt = buildMcpMutationReceipt({ workspaceId: "workspace-1" }, {
      operation: "create_image_upload",
      actor: {
        type: "agent",
        principalId: "agent-principal-1",
        source: "mcp",
      },
    });

    expect(receipt).toEqual({
      version: "1",
      operation: "create_image_upload",
      actor: {
        type: "agent",
        principalId: "agent-principal-1",
        source: "mcp",
      },
      workspaceId: "workspace-1",
    });
  });
});
