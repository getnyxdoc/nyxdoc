import { describe, expect, it } from "vitest";
import {
  canonicalDraftFields,
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
});
