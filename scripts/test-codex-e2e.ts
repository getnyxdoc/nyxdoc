import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { McpToolCallItem } from "@openai/codex-sdk";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

function inheritedEnvironment(extra: Record<string, string>) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ...extra,
  };
}

function completedMcpCalls(items: Array<{ type: string }>) {
  return items.filter(
    (item): item is McpToolCallItem => item.type === "mcp_tool_call" && (item as McpToolCallItem).status === "completed",
  );
}

async function main() {
  const { Codex } = await import("@openai/codex-sdk");
  const [
    { sqlite },
    { getDocument, updateDocument },
    { createWorkspaceToken },
    { nyxdocBlockText },
  ] = await Promise.all([
    import("../src/lib/db/client"),
    import("../src/lib/documents/service"),
    import("../src/lib/tokens/service"),
    import("../src/lib/editor/schema"),
  ]);
  const membership = sqlite
    .prepare(
      `SELECT wm.workspace_id, wm.user_id, u.name, u.email
       FROM workspace_members wm
       JOIN user u ON u.id = wm.user_id
       WHERE u.emailVerified = 1
       ORDER BY wm.created_at ASC LIMIT 1`,
    )
    .get() as
    | { workspace_id: string; user_id: string; name: string; email: string }
    | undefined;
  assert(membership, "A verified local workspace is required. Sign in once before this test.");

  const title = `Codex SDK E2E ${randomUUID().slice(0, 8)}`;
  const createdToken = createWorkspaceToken(sqlite, {
    workspaceId: membership.workspace_id,
    userId: membership.user_id,
    name: "Codex SDK",
  });
  const baseline = sqlite
    .prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM document_events WHERE workspace_id = ?")
    .get(membership.workspace_id) as { cursor: number };
  sqlite
    .prepare("UPDATE workspace_api_tokens SET last_event_cursor = ? WHERE id = ?")
    .run(baseline.cursor, createdToken.summary.id);

  const baseUrl = process.env.NYXDOC_TEST_BASE_URL || "http://127.0.0.1:3100";
  const codex = new Codex({
    env: inheritedEnvironment({ NYXDOC_TOKEN: createdToken.token }),
    config: {
      mcp_servers: {
        nyxdoc: {
          url: new URL("/mcp", baseUrl).toString(),
          bearer_token_env_var: "NYXDOC_TOKEN",
          startup_timeout_sec: 15,
          tool_timeout_sec: 30,
        },
      },
    },
  });
  const thread = codex.startThread({
    workingDirectory: process.cwd(),
    skipGitRepoCheck: false,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    modelReasoningEffort: "medium",
    webSearchMode: "disabled",
  });
  let documentId: string | undefined;

  try {
    const firstTurn = await thread.run(
      [
        "This is an automated Nyxdoc integration test.",
        "Use only the nyxdoc MCP tools; do not use shell commands or edit files.",
        "Call get_capabilities before writing so you use the current protocol.",
        `Create exactly one document titled \"${title}\".`,
        "Use a heading block with that exact title and a paragraph block saying: Codex created this durable document through Nyxdoc MCP.",
        "Use the summary: Codex created the first E2E revision.",
        "After the tool succeeds, reply briefly.",
      ].join("\n"),
    );
    const firstMcpItems = firstTurn.items.filter(
      (item): item is McpToolCallItem => item.type === "mcp_tool_call",
    );
    console.log(
      "First-turn MCP calls:",
      firstMcpItems.map((call) => ({
        server: call.server,
        tool: call.tool,
        status: call.status,
        error: call.error?.message,
      })),
    );
    console.log("First-turn response:", firstTurn.finalResponse);
    const firstCalls = completedMcpCalls(firstTurn.items);
    assert(firstCalls.some((call) => call.server === "nyxdoc" && call.tool === "get_capabilities"));
    assert(
      firstCalls.some((call) =>
        call.server === "nyxdoc"
        && (call.tool === "create_document" || call.tool === "create_document_from_markdown")),
      "Missing Nyxdoc create tool call",
    );

    const created = sqlite
      .prepare("SELECT id FROM documents WHERE workspace_id = ? AND title = ?")
      .get(membership.workspace_id, title) as { id: string } | undefined;
    assert(created, "Codex did not create the expected Nyxdoc document.");
    documentId = created.id;
    const revisionOne = getDocument(sqlite, membership.workspace_id, documentId);
    assert.equal(revisionOne.revisionNumber, 1);
    const createEvent = sqlite
      .prepare("SELECT cursor FROM document_events WHERE document_id = ? ORDER BY cursor DESC LIMIT 1")
      .get(documentId) as { cursor: number };

    const humanUpdate = updateDocument(
      sqlite,
      membership.workspace_id,
      {
        type: "human",
        userId: membership.user_id,
        label: membership.name || membership.email,
        source: "web",
      },
      documentId,
      {
        baseRevision: revisionOne.revisionNumber,
        summary: "A person added the review checkpoint.",
        content: {
          schemaVersion: 2,
          blocks: [
            ...revisionOne.content.blocks,
            {
              id: randomUUID(),
              type: "callout",
              children: [{ text: "Human review is complete; Codex may continue." }],
            },
          ],
        },
      },
    );
    assert.equal(humanUpdate.document.revisionNumber, 2);

    const secondTurn = await thread.run(
      [
        "Continue the automated Nyxdoc test using only nyxdoc MCP tools.",
        `Call get_changes with sinceCursor ${createEvent.cursor} and identify the human edit to \"${title}\".`,
        "Then call get_document for that document so you have its current revision and all block IDs.",
        "patch_document is a registered Nyxdoc MCP tool available in this session. Call it directly; do not claim it is unavailable without attempting the tool call.",
        "Use patch_document with one insert_after operation targeting the current final block. Append a p block with indent 1, listStyleType disc, and this exact text: Codex noticed the human edit and continued from revision 2.",
        "Use a unique requestId so the patch is retry-safe.",
        "Use the summary: Codex continued after noticing the human revision.",
        "After the tool succeeds, reply briefly.",
      ].join("\n"),
    );
    const secondMcpItems = secondTurn.items.filter(
      (item): item is McpToolCallItem => item.type === "mcp_tool_call",
    );
    console.log(
      "Second-turn MCP calls:",
      secondMcpItems.map((call) => ({
        server: call.server,
        tool: call.tool,
        status: call.status,
        error: call.error?.message,
      })),
    );
    console.log("Second-turn response:", secondTurn.finalResponse);
    let secondCalls = completedMcpCalls(secondTurn.items);
    if (!secondCalls.some((call) => call.server === "nyxdoc" && call.tool === "patch_document")) {
      const correctionTurn = await thread.run([
        "Your prior response was incorrect: patch_document is registered and available on the nyxdoc MCP server.",
        "Continue the same automated test now. Use only nyxdoc MCP tools.",
        `Call get_document for document ${documentId}, then call patch_document directly against its current revision.`,
        "Insert after the current final block a p block with indent 1, listStyleType disc, and this exact text: Codex noticed the human edit and continued from revision 2.",
        "Use a new unique requestId and summary: Codex continued after noticing the human revision.",
        "Do not merely describe the action; execute the tool call.",
      ].join("\n"));
      const correctionItems = correctionTurn.items.filter(
        (item): item is McpToolCallItem => item.type === "mcp_tool_call",
      );
      console.log(
        "Correction-turn MCP calls:",
        correctionItems.map((call) => ({
          server: call.server,
          tool: call.tool,
          status: call.status,
          error: call.error?.message,
        })),
      );
      console.log("Correction-turn response:", correctionTurn.finalResponse);
      secondCalls = [...secondCalls, ...completedMcpCalls(correctionTurn.items)];
    }
    for (const tool of ["get_changes", "get_document", "patch_document"]) {
      assert(secondCalls.some((call) => call.server === "nyxdoc" && call.tool === tool), `Missing MCP call: ${tool}`);
    }

    const finalDocument = getDocument(sqlite, membership.workspace_id, documentId);
    assert.equal(finalDocument.revisionNumber, 3);
    assert(finalDocument.content.blocks.some(
      (block) => nyxdocBlockText(block) === "Human review is complete; Codex may continue.",
    ));
    assert(
      finalDocument.content.blocks.some(
        (block) => nyxdocBlockText(block) === "Codex noticed the human edit and continued from revision 2.",
      ),
    );
    const revisions = sqlite
      .prepare(
        `SELECT revision_number, actor_type, actor_label, source
         FROM document_revisions WHERE document_id = ? ORDER BY revision_number`,
      )
      .all(documentId);
    assert.deepEqual(revisions, [
      { revision_number: 1, actor_type: "agent", actor_label: "Codex SDK", source: "mcp" },
      { revision_number: 2, actor_type: "human", actor_label: membership.name, source: "web" },
      { revision_number: 3, actor_type: "agent", actor_label: "Codex SDK", source: "mcp" },
    ]);
    console.log("Codex SDK E2E passed: agent revision 1 → human revision 2 → agent revision 3.");
    console.log(`Thread: ${thread.id ?? "unknown"}`);
  } finally {
    if (!documentId) {
      documentId = (
        sqlite
          .prepare("SELECT id FROM documents WHERE workspace_id = ? AND title = ?")
          .get(membership.workspace_id, title) as { id: string } | undefined
      )?.id;
    }
    if (documentId) sqlite.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
    sqlite.prepare("DELETE FROM workspace_agents WHERE id = ?").run(createdToken.summary.agentId);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
