import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { assignAgentToWorkspace } from "@/lib/agents/service";
import {
  createCollaborationCommands,
  createStoredCollaborationDocumentProvider,
} from "@/lib/collaboration/commands";
import type { NyxDatabase } from "@/lib/db/client";
import { createDocument } from "@/lib/documents/service";
import { getDocumentWebUrl } from "@/lib/documents/web-url";
import { createNyxdocMcpServer } from "@/lib/mcp/server";
import { createOrganization } from "@/lib/organizations/service";
import {
  ensureSiteAdministratorBootstrap,
  updateSiteSettings,
} from "@/lib/site-settings/service";
import { authenticateApiToken, createWorkspaceToken } from "@/lib/tokens/service";
import { createWorkspace } from "@/lib/workspaces/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("Nyxdoc MCP server", () => {
  it("exposes the Codex document workflow over the MCP protocol", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Codex",
      role: "admin",
      scopes: [
        "documents:read",
        "documents:write",
        "documents:commit",
        "changes:read",
        "revisions:restore",
      ],
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "nyxdoc-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(Buffer.byteLength(JSON.stringify(listed.tools), "utf8")).toBeLessThan(80_000);
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "list_agent_workspaces",
        "get_capabilities",
        "get_schema",
        "list_documents",
        "get_document",
        "get_working_document",
        "get_document_outline",
        "get_document_markdown",
        "patch_document_markdown",
        "batch_get_documents",
        "get_backlinks",
        "export_document",
        "create_image_upload",
        "create_document",
        "update_document",
        "create_document_from_markdown",
        "capture_handoff",
        "update_document_from_markdown",
        "patch_document",
        "commit_document",
        "get_changes",
        "search_documents",
        "get_workspace_context",
        "list_workspace_agents",
        "list_audit_events",
        "list_admin_action_requests",
        "propose_admin_action",
        "list_trash",
        "trash_document",
        "restore_trashed_document",
        "list_saved_views",
        "run_saved_view",
        "create_saved_view",
        "update_saved_view",
        "delete_saved_view",
        "list_my_tasks",
        "get_task",
        "create_task",
        "claim_task",
        "report_task",
        "complete_task",
        "list_my_work",
        "list_assignments",
        "assign_document",
        "update_assignment",
        "set_presence",
        "end_presence",
        "list_revisions",
        "get_revision",
        "diff_revisions",
        "restore_revision",
      ]);
      expect(client.getInstructions()).toContain("get_working_document");
      expect(client.getInstructions()).toContain("latest draftVersion at the top level");
      expect(client.getInstructions()).toContain("list_my_work");
      expect(client.getInstructions()).toContain("list_my_tasks");
      expect(client.getInstructions()).toContain("capture_handoff");
      expect(client.getInstructions()).toContain(
        "Call claim_task only after a human explicitly asks you to process Nyxdoc Agent To-dos",
      );
      expect(client.getInstructions()).toContain("otherwise wait and do not modify documents");
      expect(client.getInstructions()).toContain("owner leads the document");
      expect(client.getInstructions()).toContain("Creating a document creates its initial canonical revision 1");
      expect(client.getInstructions()).toContain("This path never needs the full AST");
      expect(client.getInstructions()).toContain(
        "use Nyxdoc MCP tools instead of browser UI automation",
      );
      expect(client.getInstructions()).toContain(
        "return webUrl exactly; never guess the app URL or inspect a browser",
      );
      expect(client.getInstructions()).toContain(
        "never repeat the same title as a leading H1 or other heading inside content or Markdown",
      );
      expect(client.getInstructions()).toContain(
        "Never use a person's logged-in browser session",
      );
      expect(client.getInstructions()).toContain(
        "The workspace open in a person's browser never controls agent access or routing",
      );
      expect(client.getInstructions()).toContain(
        "Document-ID tools infer the workspace from the document",
      );
      expect(client.getInstructions()).toContain("call create_image_upload");
      expect(client.getInstructions()).toContain("Never embed base64 image data");
      expect(client.getInstructions()).not.toContain("legacy");
      const createTool = listed.tools.find((tool) => tool.name === "create_document")!;
      const createInputSchema = createTool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(createInputSchema.properties).not.toHaveProperty("blocks");
      expect(createInputSchema.required).toContain("content");
      expect(createTool.annotations).toMatchObject({ idempotentHint: true });
      expect(JSON.stringify(createInputSchema.properties?.content)).toContain("get_schema");
      expect(JSON.stringify(createInputSchema.properties?.content)).toContain(
        "must not be repeated as the leading body heading",
      );
      expect(JSON.stringify(createInputSchema.properties?.content)).not.toContain("fontSize");
      const commitTool = listed.tools.find((tool) => tool.name === "commit_document")!;
      const commitInputSchema = commitTool.inputSchema as {
        required?: string[];
      };
      expect(commitInputSchema.required?.toSorted()).toEqual([
        "documentId",
        "expectedDraftVersion",
        "requestId",
      ]);
      const claimTaskTool = listed.tools.find((tool) => tool.name === "claim_task")!;
      expect(claimTaskTool.description).toContain(
        "only after a human explicitly asks you to process Nyxdoc Agent To-dos",
      );
      const captureHandoffTool = listed.tools.find((tool) => tool.name === "capture_handoff")!;
      expect(captureHandoffTool.description).toContain("never starts the To-dos");
      const createFromMarkdownTool = listed.tools.find(
        (tool) => tool.name === "create_document_from_markdown",
      )!;
      expect(createFromMarkdownTool.description).toContain(
        "omit a leading Markdown heading that repeats it",
      );

      const capabilityResult = await client.callTool({ name: "get_capabilities", arguments: {} });
      expect(capabilityResult.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "get_capabilities",
        capabilities: {
          protocolVersion: "4.13.0",
          profile: "summary",
          unchanged: false,
          document: {
            schemaVersion: 2,
            externalLinkPresentation: {
              rawUrlTextResolvesToPublicPageTitleInWorkspaceClients: true,
              lookupFailureKeepsRawClickableUrl: true,
              opensInNewTab: true,
            },
            humanFacingWebUrl: {
              field: "webUrl",
              absolute: true,
              generatedByServer: true,
              useForHumanHandoff: true,
              neverGuessOrDiscoverWithBrowser: true,
            },
            titlePresentation: {
              field: "title",
              renderedSeparatelyFromBody: true,
              actsAsPageTopLevelHeading: true,
              repeatTitleAsLeadingBodyHeading: false,
              markdownIncludesPageTitleHeading: false,
            },
          },
          responses: {
            mutationDefault: "summary",
            fullAstIsOptIn: true,
            schemasIncludedByDefault: false,
          },
          schemaDiscovery: { tool: "get_schema" },
          recommendedWorkflow: {
            focusedMarkdownEdit: expect.arrayContaining(["get_document_markdown(sectionId)"]),
            imageUpload: expect.arrayContaining(["create_image_upload"]),
          },
          concurrency: {
            automaticMerge: "section-hash-guarded-for-markdown-patches",
            creationCreatesInitialRevision: true,
            responseContract: {
              latestDraftVersionPath: "draftVersion",
              appliesToDraftAwareReadsAndMutations: true,
              nestedStateRetainedForCompatibility: true,
            },
            sectionMarkdownPatch: {
              staleDraftVersionRebasesWhenSectionHashMatches: true,
            },
          },
          retrieval: {
            documentOutline: true,
            partialMarkdownReadBySectionId: true,
          },
          media: {
            uploadTool: "create_image_upload",
            inlineBase64Allowed: false,
          },
          connection: {
            defaultWorkspace: {
              id: workspace.id,
              name: workspace.name,
              namespace: {
                type: "personal",
                id: user.id,
              },
            },
            routing: {
              browserSelectionAffectsAgent: false,
              defaultWorkspaceIsFallbackOnly: true,
              documentIdToolsInferWorkspace: true,
              ambiguousToolsAcceptWorkspaceId: true,
            },
          },
        },
      });
      expect(JSON.stringify(capabilityResult.structuredContent)).not.toContain("jsonSchema");
      expect(Buffer.byteLength(JSON.stringify(capabilityResult.structuredContent), "utf8"))
        .toBeLessThan(10_000);

      const taskCapabilities = await client.callTool({
        name: "get_capabilities",
        arguments: { profile: "tasks" },
      });
      expect(taskCapabilities.structuredContent).toMatchObject({
        capabilities: {
          profile: "tasks",
          tasks: {
            displayName: "Agent To-do",
            automaticExecutionOnConnection: false,
            executionAuthorization: { explicitHumanRequestRequired: true },
          },
          collaboration: { simultaneousCharacterEditing: true },
        },
      });

      const documentSchema = await client.callTool({
        name: "get_schema",
        arguments: { name: "document_content" },
      });
      expect(documentSchema.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "get_schema",
        name: "document_content",
        protocolVersion: "4.13.0",
        schemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        jsonSchema: {
          description: expect.stringContaining(
            "do not repeat it as a leading H1 or other body heading",
          ),
        },
      });

      const unchangedCapabilities = await client.callTool({
        name: "get_capabilities",
        arguments: { sinceProtocolVersion: "4.13.0" },
      });
      expect(unchangedCapabilities.structuredContent).toMatchObject({
        capabilities: { protocolVersion: "4.13.0", unchanged: true },
      });

      const imageUpload = await client.callTool({
        name: "create_image_upload",
        arguments: {
          filename: "agent-capture.png",
          mimeType: "image/png",
          byteSize: 68,
          alt: "에이전트 캡처",
        },
      });
      expect(imageUpload.structuredContent).toMatchObject({
        workspaceId: workspace.id,
        documentId: null,
        upload: {
          method: "PUT",
          url: expect.stringMatching(/^http:\/\/localhost:3100\/api\/media\/agent-uploads\//),
          headers: {
            Authorization: expect.stringMatching(/^NyxUpload nyx_upload_/),
            "Content-Type": "image/png",
          },
          body: "raw-image-bytes",
          expiresInSeconds: 300,
          singleUse: true,
        },
      });
      const authorization = (imageUpload.structuredContent as {
        upload: { headers: { Authorization: string } };
      }).upload.headers.Authorization;
      expect(JSON.stringify(database.prepare(
        "SELECT token_hash, token_prefix FROM agent_media_upload_tickets",
      ).get())).not.toContain(authorization);

      const workspaceResult = await client.callTool({ name: "list_agent_workspaces", arguments: {} });
      expect(workspaceResult.structuredContent).toMatchObject({
        agentId: identity.globalAgentId,
        credentialId: identity.id,
        defaultWorkspaceId: workspace.id,
        routing: {
          browserSelectionAffectsAgent: false,
          documentId: "workspace-inferred",
          ambiguousOperations: "pass-workspaceId-or-use-default",
          defaultSelectors: { header: "x-nyxdoc-workspace-id", query: "workspace" },
        },
        workspaces: [{
          id: workspace.id,
          membershipId: identity.agentId,
          role: "admin",
          default: true,
          namespace: { type: "personal", id: user.id },
          effectivePermissions: expect.arrayContaining(["documents.read", "documents.commit"]),
        }],
      });

      const createArguments = {
        requestId: "mcp-create-scenario-001",
        title: "Codex MCP 시나리오",
        summary: "Codex가 MCP로 시나리오 문서를 만들었습니다.",
        content: {
          schemaVersion: 2,
          blocks: [
            { id: "mcp-title", type: "h2", children: [{ text: "개요" }] },
            { id: "mcp-body", type: "p", children: [{ text: "사람과 Codex가 같은 문서를 이어서 고칩니다." }] },
            { id: "mcp-list", type: "p", listStyleType: "disc", indent: 2, children: [{ text: "중첩된 확인 항목" }] },
            {
              id: "mcp-table",
              type: "table",
              children: [
                {
                  id: "mcp-table-row-1",
                  type: "tr",
                  children: [
                    { id: "mcp-table-head-1", type: "th", children: [{ id: "mcp-table-head-p-1", type: "p", children: [{ text: "기능" }] }] },
                    { id: "mcp-table-head-2", type: "th", children: [{ id: "mcp-table-head-p-2", type: "p", children: [{ text: "상태" }] }] },
                  ],
                },
                {
                  id: "mcp-table-row-2",
                  type: "tr",
                  children: [
                    { id: "mcp-table-cell-1", type: "td", children: [{ id: "mcp-table-cell-p-1", type: "p", children: [{ text: "MCP" }] }] },
                    { id: "mcp-table-cell-2", type: "td", children: [{ id: "mcp-table-cell-p-2", type: "p", children: [{ text: "연결됨" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      };
      const createResult = await client.callTool({
        name: "create_document",
        arguments: createArguments,
      });
      expect(createResult.isError).not.toBe(true);
      const structured = createResult.structuredContent as {
        webUrl: string;
        document: {
          id: string;
          webUrl: string;
          revisionNumber: number;
          content: { blockCount: number; contentDigest: string };
        };
        eventCursor: number;
      };
      expect(structured.document.revisionNumber).toBe(1);
      const documentWebUrl = getDocumentWebUrl(workspace.id, structured.document.id);
      expect(structured.webUrl).toBe(documentWebUrl);
      expect(structured.document.webUrl).toBe(documentWebUrl);
      expect(createResult.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "create_document",
        responseMode: "summary",
        blockCount: 4,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        response: { mode: "summary", omittedFields: expect.arrayContaining(["document.content.blocks"]) },
      });
      expect(structured.document.content).not.toHaveProperty("blocks");
      const createReplay = await client.callTool({ name: "create_document", arguments: createArguments });
      expect(createReplay.structuredContent).toEqual(createResult.structuredContent);
      const createFull = await client.callTool({
        name: "create_document",
        arguments: { ...createArguments, responseMode: "full" },
      });
      expect((createFull.structuredContent as {
        document: { content: { blocks: unknown[] } };
      }).document.content.blocks).toHaveLength(4);

      const createTaskArguments = {
        requestId: "mcp-create-task-scenario-001",
        workspaceId: workspace.id,
        title: "MCP 소개 문서 점검",
        description: "소개 문서의 메시지를 더 명확하게 다듬습니다.",
        acceptanceCriteria: "결과 리비전을 연결하고 변경 내용을 한 문장으로 요약합니다.",
        priority: "high",
        targetDocumentId: structured.document.id,
        assignedAgentId: identity.agentId,
        requiresReview: true,
      };
      const createTaskResult = await client.callTool({
        name: "create_task",
        arguments: createTaskArguments,
      });
      expect(createTaskResult.structuredContent).toMatchObject({
        task: {
          title: createTaskArguments.title,
          status: "ready",
          priority: "high",
          targetDocumentId: structured.document.id,
          assignedAgentId: identity.agentId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          requiresReview: true,
          version: 1,
        },
        grantsAccess: false,
        started: false,
      });
      const createdTask = (createTaskResult.structuredContent as {
        task: { id: string; version: number };
      }).task;
      expect((await client.callTool({
        name: "create_task",
        arguments: createTaskArguments,
      })).structuredContent).toEqual(createTaskResult.structuredContent);

      expect((await client.callTool({
        name: "list_my_tasks",
        arguments: {},
      })).structuredContent).toMatchObject({
        tasks: [{
          id: createdTask.id,
          status: "ready",
          targetDocumentId: structured.document.id,
        }],
        total: 1,
        includesAssignedToMe: true,
        scope: "global_agent",
        workspaceFilter: null,
        includesUnassigned: false,
        truncated: false,
        grantsAccess: false,
        automaticExecution: false,
        executionAuthorization: {
          requiredTrigger: "explicit-human-request",
          explicitHumanRequestRequired: true,
          connectionAuthorizesExecution: false,
          listingAuthorizesExecution: false,
          readingAuthorizesExecution: false,
          discoveryAuthorizesExecution: false,
          actionWithoutExplicitHumanRequest: "wait",
        },
        nextAction:
          "Wait. Call claim_task only after a human explicitly asks you to process Nyxdoc Agent To-dos.",
      });
      expect((await client.callTool({
        name: "get_task",
        arguments: { taskId: createdTask.id },
      })).structuredContent).toMatchObject({
        task: { id: createdTask.id, status: "ready", version: 1 },
        events: [{ eventType: "created" }],
        grantsAccess: false,
        executionAuthorization: {
          requiredTrigger: "explicit-human-request",
          explicitHumanRequestRequired: true,
          actionWithoutExplicitHumanRequest: "wait",
        },
        canClaim: true,
      });

      const claimTaskArguments = {
        taskId: createdTask.id,
        expectedVersion: 1,
        requestId: "mcp-claim-task-scenario-001",
        message: "문서 점검을 시작합니다.",
      };
      const claimTaskResult = await client.callTool({
        name: "claim_task",
        arguments: claimTaskArguments,
      });
      expect(claimTaskResult.structuredContent).toMatchObject({
        task: {
          id: createdTask.id,
          status: "in_progress",
          assignedAgentId: identity.agentId,
          version: 2,
        },
        grantsAccess: false,
      });
      expect((await client.callTool({
        name: "claim_task",
        arguments: claimTaskArguments,
      })).structuredContent).toEqual(claimTaskResult.structuredContent);

      const reportTaskResult = await client.callTool({
        name: "report_task",
        arguments: {
          taskId: createdTask.id,
          expectedVersion: 2,
          requestId: "mcp-report-task-scenario-001",
          status: "in_progress",
          progress: 40,
          message: "현재 문구와 문서 구조를 확인했습니다.",
        },
      });
      expect(reportTaskResult.structuredContent).toMatchObject({
        task: { id: createdTask.id, status: "in_progress", progress: 40, version: 3 },
      });

      const completeTaskArguments = {
        taskId: createdTask.id,
        expectedVersion: 3,
        requestId: "mcp-complete-task-scenario-001",
        resultSummary: "문서 메시지와 구조를 검토하고 결과 리비전을 연결했습니다.",
        resultDocumentId: structured.document.id,
        resultRevisionNumber: 1,
      };
      const completeTaskResult = await client.callTool({
        name: "complete_task",
        arguments: completeTaskArguments,
      });
      expect(completeTaskResult.structuredContent).toMatchObject({
        task: {
          id: createdTask.id,
          status: "review",
          progress: 100,
          resultDocumentId: structured.document.id,
          resultRevisionNumber: 1,
          version: 4,
        },
        grantsAccess: false,
      });
      expect((await client.callTool({
        name: "complete_task",
        arguments: completeTaskArguments,
      })).structuredContent).toEqual(completeTaskResult.structuredContent);

      const assignmentResult = await client.callTool({
        name: "assign_document",
        arguments: {
          documentId: structured.document.id,
          agentId: identity.agentId,
          assignmentType: "owner",
          note: "제품 문서의 결과를 책임집니다.",
        },
      });
      expect(assignmentResult.structuredContent).toMatchObject({
        assignment: {
          documentId: structured.document.id,
          agentId: identity.agentId,
          assignmentType: "owner",
          roleGuidance: {
            label: "Lead",
            expectedBehavior: expect.stringContaining("responsible through completion"),
          },
        },
        grantsAccess: false,
      });

      const workspaceContext = await client.callTool({
        name: "get_workspace_context",
        arguments: {},
      });
      expect(workspaceContext.structuredContent).toMatchObject({
        workspace: {
          counts: { availableDocumentTasks: 1 },
        },
        myWork: {
          available: true,
          activeAssignmentCount: 1,
          activeDocumentCount: 1,
          assignments: [{
            documentId: structured.document.id,
            assignmentType: "owner",
            roleGuidance: { label: "Lead" },
          }],
          truncated: false,
          listTool: "list_my_work",
          grantsAccess: false,
        },
        myTasks: {
          available: true,
          openTaskCount: 1,
          assignedToMeCount: 1,
          unassignedCount: 0,
          tasks: [{ id: createdTask.id, status: "review" }],
          truncated: false,
          listTool: "list_my_tasks",
          grantsAccess: false,
          automaticExecution: false,
        },
      });

      const myWorkResult = await client.callTool({
        name: "list_my_work",
        arguments: {},
      });
      expect(myWorkResult.structuredContent).toMatchObject({
        assignments: [{
          documentId: structured.document.id,
          assignmentType: "owner",
          roleGuidance: { label: "Lead" },
        }],
        status: "active",
        assignmentType: null,
        total: 1,
        nextOffset: null,
        grantsAccess: false,
        roleDefinitions: {
          owner: { label: "Lead" },
          contributor: { label: "Contributor" },
          reviewer: { label: "Reviewer" },
        },
      });
      expect((await client.callTool({
        name: "list_assignments",
        arguments: { documentId: structured.document.id, status: "active" },
      })).structuredContent).toMatchObject({
        assignments: [{
          documentId: structured.document.id,
          agentId: identity.agentId,
          roleGuidance: { label: "Lead" },
        }],
        roleDefinitions: {
          owner: { label: "Lead" },
          contributor: { label: "Contributor" },
          reviewer: { label: "Reviewer" },
        },
        grantsAccess: false,
      });

      const readResult = await client.callTool({
        name: "get_document",
        arguments: { documentId: structured.document.id },
      });
      expect(readResult.structuredContent).toMatchObject({
        myWork: {
          available: true,
          assigned: true,
          assignments: [{
            documentId: structured.document.id,
            assignmentType: "owner",
            roleGuidance: { label: "Lead" },
          }],
          grantsAccess: false,
        },
      });
      const readDocument = (readResult.structuredContent as {
        document: {
          title: string;
          revisionNumber: number;
          content: { schemaVersion: 2; blocks: Array<Record<string, unknown>> };
        };
      }).document;
      expect(readDocument.title).toBe("Codex MCP 시나리오");
      expect(readDocument).not.toHaveProperty("blocks");
      expect(readDocument).not.toHaveProperty("contentSchemaVersion");
      expect(readDocument.content.blocks[2]).toMatchObject({ type: "p", listStyleType: "disc", indent: 2 });
      expect(readDocument.content.blocks[3]).toMatchObject({ type: "table" });
      const compactReadText = ((readResult.content ?? []) as Array<{ type: string; text?: string }>)
        .find((item) => item.type === "text")?.text ?? "";
      expect(compactReadText).toContain('"blockCount"');
      expect(compactReadText).not.toContain('"blocks"');
      expect(compactReadText.length).toBeLessThan(JSON.stringify(readResult.structuredContent).length);

      const initialWorkingResult = await client.callTool({
        name: "get_working_document",
        arguments: { documentId: structured.document.id },
      });
      expect(initialWorkingResult.structuredContent).toMatchObject({
        draftVersion: 0,
        baseRevisionNumber: 1,
        hasUncommittedChanges: false,
        myWork: {
          available: true,
          assigned: true,
          assignments: [{
            documentId: structured.document.id,
            roleGuidance: { label: "Lead" },
          }],
        },
      });
      const initialWorking = (initialWorkingResult.structuredContent as {
        workingDocument: { draftVersion: number; baseRevisionNumber: number };
      }).workingDocument;
      expect(initialWorking).toMatchObject({ draftVersion: 0, baseRevisionNumber: 1 });

      const outlineResult = await client.callTool({
        name: "get_document_outline",
        arguments: { documentId: structured.document.id, source: "working" },
      });
      expect(outlineResult.structuredContent).toMatchObject({
        draftVersion: 0,
        baseRevisionNumber: 1,
        hasUncommittedChanges: false,
        document: { draftVersion: 0, source: "working" },
        sections: [{ sectionId: "mcp-title", sectionHash: expect.stringMatching(/^[0-9a-f]{64}$/) }],
        next: { tool: "get_document_markdown" },
        response: { omittedFields: expect.arrayContaining(["sections[].headingPath"]) },
      });
      expect((outlineResult.structuredContent as { sections: Array<Record<string, unknown>> })
        .sections[0]).not.toHaveProperty("headingPath");
      const markdownSectionResult = await client.callTool({
        name: "get_document_markdown",
        arguments: { documentId: structured.document.id, sectionId: "mcp-title" },
      });
      const markdownSection = markdownSectionResult.structuredContent as {
        selector: { sectionHash: string };
        markdown: string;
      };
      expect(markdownSection.markdown).toContain("## 개요");
      expect(markdownSectionResult.structuredContent).toMatchObject({
        draftVersion: 0,
        baseRevisionNumber: 1,
        hasUncommittedChanges: false,
        next: {
          tool: "patch_document_markdown",
          arguments: {
            documentId: structured.document.id,
            sectionId: "mcp-title",
            expectedDraftVersion: 0,
            dryRun: true,
          },
        },
      });
      const sectionPreview = await client.callTool({
        name: "patch_document_markdown",
        arguments: {
          documentId: structured.document.id,
          sectionId: "mcp-title",
          expectedSectionHash: markdownSection.selector.sectionHash,
          expectedDraftVersion: 0,
          requestId: "mcp-section-preview-001",
          markdown: "## 개요\n\n부분 Markdown 미리보기입니다.",
          dryRun: true,
        },
      });
      expect(sectionPreview.structuredContent).toMatchObject({
        documentId: structured.document.id,
        sectionId: "mcp-title",
        dryRun: true,
        draftVersion: 0,
        currentDraftVersion: 0,
        after: { sectionId: "mcp-title" },
      });

      const richContent = structuredClone(readDocument.content);
      richContent.blocks.push({
        id: "mcp-rich-paragraph",
        type: "p",
        align: "center",
        children: [{ text: "AST v2로 보존되는 문단", bold: true, fontSize: "24px" }],
      });
      const richUpdate = await client.callTool({
        name: "update_document",
        arguments: {
          documentId: structured.document.id,
          requestId: "mcp-update-scenario-001",
          expectedDraftVersion: initialWorking.draftVersion,
          content: richContent,
          documentType: "product-plan",
          workflowStatus: "review",
          tags: ["release", "agent"],
        },
      });
      expect(richUpdate.isError).not.toBe(true);
      expect(richUpdate.structuredContent).toMatchObject({
        draftVersion: 1,
        baseRevisionNumber: 1,
        hasUncommittedChanges: true,
      });
      expect((richUpdate.structuredContent as {
        workingDocument: {
          draftVersion: number;
          baseRevisionNumber: number;
          metadata: { documentType: string; workflowStatus: string; tags: string[] };
        };
      }).workingDocument).toMatchObject({
        draftVersion: 1,
        baseRevisionNumber: 1,
        metadata: {
          documentType: "product-plan",
          workflowStatus: "review",
          tags: ["release", "agent"],
        },
      });
      expect((await client.callTool({
        name: "get_document",
        arguments: { documentId: structured.document.id },
      })).structuredContent).toMatchObject({ document: { revisionNumber: 1 } });

      const patchArguments = {
        documentId: structured.document.id,
        expectedDraftVersion: 1,
        requestId: "mcp-patch-scenario-001",
        operations: [{
          op: "replace_block",
          blockId: "mcp-rich-paragraph",
          block: { type: "p", align: "right", children: [{ text: "부분 수정 완료", bold: true }] },
        }],
      };
      const patchResult = await client.callTool({ name: "patch_document", arguments: patchArguments });
      expect(patchResult.structuredContent).toMatchObject({
        draftVersion: 2,
        baseRevisionNumber: 1,
        hasUncommittedChanges: true,
      });
      expect((patchResult.structuredContent as {
        workingDocument: { draftVersion: number; baseRevisionNumber: number };
      }).workingDocument).toMatchObject({ draftVersion: 2, baseRevisionNumber: 1 });
      const patchReplay = await client.callTool({ name: "patch_document", arguments: patchArguments });
      expect(patchReplay.structuredContent).toEqual(patchResult.structuredContent);
      const stalePatch = await client.callTool({
        name: "patch_document",
        arguments: {
          ...patchArguments,
          requestId: "mcp-patch-stale-001",
          operations: [{
            op: "replace_block",
            blockId: "mcp-rich-paragraph",
            block: { type: "p", children: [{ text: "오래된 기준의 수정" }] },
          }],
        },
      });
      expect(stalePatch.isError).toBe(true);
      expect(stalePatch.structuredContent).toMatchObject({
        code: "DRAFT_CONFLICT",
        errorSource: "service",
        reason: expect.any(String),
        expectedDraftVersion: 1,
        currentDraftVersion: 2,
      });

      const commitArguments = {
        documentId: structured.document.id,
        expectedDraftVersion: 2,
        requestId: "mcp-commit-scenario-001",
        summary: "Codex가 검토한 공유 초안을 정본으로 저장했습니다.",
      };
      const commitResult = await client.callTool({ name: "commit_document", arguments: commitArguments });
      expect(commitResult.isError).not.toBe(true);
      expect(commitResult.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "commit_document",
        responseMode: "summary",
        draftVersion: 2,
        baseRevisionNumber: 2,
        hasUncommittedChanges: false,
        webUrl: documentWebUrl,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        document: {
          id: structured.document.id,
          webUrl: documentWebUrl,
          revisionNumber: 2,
          documentType: "product-plan",
          workflowStatus: "review",
          tags: ["release", "agent"],
        },
        workingDocument: {
          webUrl: documentWebUrl,
          draftVersion: 2,
          baseRevisionNumber: 2,
          hasUncommittedChanges: false,
        },
      });
      const commitReplay = await client.callTool({ name: "commit_document", arguments: commitArguments });
      expect(commitReplay.structuredContent).toEqual(commitResult.structuredContent);

      const searchResult = await client.callTool({
        name: "search_documents",
        arguments: { query: "부분 수정 완료" },
      });
      expect(searchResult.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "search_documents",
        results: [{
          documentId: structured.document.id,
          webUrl: documentWebUrl,
          revisionNumber: 2,
          pathText: "Codex MCP 시나리오",
          matches: [{
            kind: "body",
            blockId: "mcp-rich-paragraph",
            nodeType: "p",
            sectionId: "mcp-title",
            headingPath: ["개요"],
            sectionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          }],
        }],
        next: { tool: "get_document_markdown" },
        response: { omittedFields: expect.arrayContaining(["documents", "results[].path"]) },
      });
      expect(searchResult.structuredContent).not.toHaveProperty("documents");
      expect((searchResult.structuredContent as { results: Array<Record<string, unknown>> })
        .results[0]).not.toHaveProperty("path");

      const batchResult = await client.callTool({
        name: "batch_get_documents",
        arguments: { documentIds: [structured.document.id] },
      });
      expect(batchResult.structuredContent).toMatchObject({
        documents: [{
          id: structured.document.id,
          webUrl: documentWebUrl,
          revisionNumber: 2,
        }],
        missingDocumentIds: [],
        myWork: [{
          documentId: structured.document.id,
          available: true,
          assigned: true,
          assignments: [{
            assignmentType: "owner",
            roleGuidance: { label: "Lead" },
          }],
          grantsAccess: false,
        }],
      });

      const revisionsResult = await client.callTool({
        name: "list_revisions",
        arguments: { documentId: structured.document.id },
      });
      expect(revisionsResult.structuredContent).toMatchObject({
        documentId: structured.document.id,
        webUrl: documentWebUrl,
      });
      expect((revisionsResult.structuredContent as { revisions: unknown[] }).revisions).toHaveLength(2);
      const revisionResult = await client.callTool({
        name: "get_revision",
        arguments: { documentId: structured.document.id, revisionNumber: 1 },
      });
      expect(revisionResult.structuredContent).toMatchObject({ revision: { number: 1 } });
      const diffResult = await client.callTool({
        name: "diff_revisions",
        arguments: { documentId: structured.document.id, fromRevision: 1, toRevision: 2 },
      });
      expect(diffResult.structuredContent).toMatchObject({
        documentId: structured.document.id,
        webUrl: documentWebUrl,
        diff: { documentId: structured.document.id, fromRevision: 1, toRevision: 2 },
      });

      const restoreArguments = {
        documentId: structured.document.id,
        revisionNumber: 1,
        requestId: "mcp-restore-scenario-001",
      };
      const restoreResult = await client.callTool({ name: "restore_revision", arguments: restoreArguments });
      expect(restoreResult.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "restore_revision",
        responseMode: "summary",
        workingDocument: {
          documentId: structured.document.id,
          baseRevisionNumber: 2,
          draftVersion: 1,
          hasUncommittedChanges: true,
          content: {
            schemaVersion: 2,
            blockCount: expect.any(Number),
            contentDigest: expect.any(String),
          },
        },
      });
      const restoreReplay = await client.callTool({ name: "restore_revision", arguments: restoreArguments });
      expect(restoreReplay.structuredContent).toEqual(restoreResult.structuredContent);
      expect((await client.callTool({
        name: "get_document",
        arguments: { documentId: structured.document.id },
      })).structuredContent).toMatchObject({ document: { revisionNumber: 2 } });

      const restoreCommit = await client.callTool({
        name: "commit_document",
        arguments: {
          documentId: structured.document.id,
          expectedDraftVersion: 1,
          requestId: "mcp-commit-restored-scenario-001",
          summary: "검토한 과거 내용을 새 정본으로 저장했습니다.",
        },
      });
      expect(restoreCommit.structuredContent).toMatchObject({
        document: { id: structured.document.id, revisionNumber: 3 },
        workingDocument: { hasUncommittedChanges: false, baseRevisionNumber: 3 },
      });

      const childResult = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "mcp-create-child-001",
          title: "MCP 하위 문서",
          parentDocumentId: structured.document.id,
          summary: "Codex가 부모 문서 아래에 새 문서를 만들었습니다.",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "mcp-child-body", type: "p", children: [{ text: "문서가 폴더 역할도 합니다." }] }],
          },
        },
      });
      const childDocument = (childResult.structuredContent as {
        document: { id: string; parentDocumentId: string | null; revisionNumber: number };
      }).document;
      expect(childDocument.parentDocumentId).toBe(structured.document.id);
      expect((await client.callTool({
        name: "assign_document",
        arguments: {
          documentId: childDocument.id,
          agentId: identity.agentId,
          assignmentType: "reviewer",
          note: "하위 문서의 정확성을 검토합니다.",
        },
      })).structuredContent).toMatchObject({
        assignment: {
          documentId: childDocument.id,
          assignmentType: "reviewer",
          roleGuidance: {
            label: "Reviewer",
            expectedBehavior: expect.stringContaining("accuracy"),
          },
        },
      });
      const trashed = await client.callTool({
        name: "trash_document",
        arguments: {
          documentId: childDocument.id,
          baseRevision: childDocument.revisionNumber,
        },
      });
      expect(trashed.structuredContent).toMatchObject({
        archivedDocumentIds: [childDocument.id],
        archivedCount: 1,
      });
      const workAfterTrash = await client.callTool({ name: "list_my_work", arguments: {} });
      expect(workAfterTrash.structuredContent).toMatchObject({
        assignments: [expect.objectContaining({ documentId: structured.document.id })],
        total: 1,
      });
      expect((workAfterTrash.structuredContent as {
        assignments: Array<{ documentId: string }>;
      }).assignments).not.toContainEqual(expect.objectContaining({ documentId: childDocument.id }));
      expect((await client.callTool({ name: "list_trash", arguments: {} })).structuredContent)
        .toMatchObject({ trash: [expect.objectContaining({ rootDocumentId: childDocument.id })] });
      expect((await client.callTool({
        name: "restore_trashed_document",
        arguments: { documentId: childDocument.id },
      })).structuredContent).toMatchObject({ documentIds: [childDocument.id] });

      const markdownArguments = {
        requestId: "mcp-markdown-scenario-001",
        title: "Markdown 문서",
        documentType: "research",
        workflowStatus: "draft",
        tags: ["markdown"],
        markdown: [
          "# Markdown 가져오기",
          "",
          "#### 더 깊은 제목",
          "",
          `관련 문서는 [여기](nyxdoc://document/${structured.document.id})입니다.`,
          "",
          "```typescript",
          "const imported = true;",
          "```",
        ].join("\n"),
      };
      const markdownResult = await client.callTool({
        name: "create_document_from_markdown",
        arguments: markdownArguments,
      });
      const markdownDocument = (markdownResult.structuredContent as {
        document: { id: string; content: { blockCount: number; contentDigest: string } };
      }).document;
      expect(markdownResult.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "create_document_from_markdown",
        responseMode: "summary",
        blockCount: 4,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        conversionWarnings: [],
      });
      expect(markdownDocument.content).not.toHaveProperty("blocks");
      const markdownRead = await client.callTool({
        name: "get_document",
        arguments: { documentId: markdownDocument.id },
      });
      expect((markdownRead.structuredContent as {
        document: { content: { blocks: Array<{ type: string }> } };
      }).document.content.blocks.map((block) => block.type)).toEqual(["h1", "h4", "p", "code_block"]);
      const markdownReplay = await client.callTool({
        name: "create_document_from_markdown",
        arguments: markdownArguments,
      });
      expect(markdownReplay.structuredContent).toEqual(markdownResult.structuredContent);
      expect(database.prepare(
        "SELECT operation FROM agent_write_requests WHERE token_id = ? ORDER BY created_at, operation",
      ).all(token.summary.id)).toEqual(expect.arrayContaining([
        { operation: "create_document" },
        { operation: "create_document_from_markdown" },
      ]));
      expect(database.prepare(
        "SELECT operation FROM collaboration_idempotency_requests ORDER BY created_at, operation",
      ).all()).toEqual(expect.arrayContaining([
        { operation: "replace_draft" },
        { operation: "patch_draft" },
        { operation: "commit_draft" },
        { operation: "restore_revision_to_draft" },
      ]));
      expect(database.prepare(
        "SELECT operation FROM agent_credential_write_requests WHERE credential_id = ? ORDER BY created_at, operation",
      ).all(token.summary.id)).toEqual(expect.arrayContaining([
        { operation: "create_document_task" },
        { operation: "claim_document_task" },
        { operation: "report_document_task" },
        { operation: "complete_document_task" },
      ]));

      const backlinks = await client.callTool({
        name: "get_backlinks",
        arguments: { documentId: structured.document.id },
      });
      expect(backlinks.structuredContent).toMatchObject({
        backlinks: [{ document: { id: markdownDocument.id } }],
      });
      const exported = await client.callTool({
        name: "export_document",
        arguments: { documentId: markdownDocument.id, format: "nyxdoc_json" },
      });
      expect(exported.structuredContent).toMatchObject({
        format: "nyxdoc_json",
        data: { bundleVersion: 1, document: { id: markdownDocument.id } },
      });

      const changes = await client.callTool({
        name: "get_changes",
        arguments: { sinceCursor: structured.eventCursor - 1 },
      });
      const events = (changes.structuredContent as { events: Array<{ actorLabel: string; source: string }> })
        .events;
      expect(events.at(-1)).toMatchObject({ actorLabel: "Codex", source: "mcp" });
      expect(database.prepare("SELECT last_event_cursor FROM workspace_api_tokens WHERE id = ?")
        .get(token.summary.id)).toEqual({ last_event_cursor: 0 });

      const futureCursor = 999_999_999;
      database.prepare("UPDATE workspace_api_tokens SET last_event_cursor = ? WHERE id = ?")
        .run(futureCursor, token.summary.id);
      database.prepare(
        `UPDATE agent_credential_workspace_state SET last_event_cursor = ?
         WHERE credential_id = ? AND workspace_id = ?`,
      ).run(futureCursor, token.summary.id, workspace.id);
      const healed = await client.callTool({ name: "get_changes", arguments: {} });
      const healedChanges = healed.structuredContent as { cursorClamped: boolean; nextCursor: number };
      expect(healedChanges.cursorClamped).toBe(true);
      expect(database.prepare("SELECT last_event_cursor FROM workspace_api_tokens WHERE id = ?")
        .get(token.summary.id)).toEqual({ last_event_cursor: healedChanges.nextCursor });

      const afterHeal = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "mcp-create-after-cursor-heal-001",
          title: "커서 복구 이후 문서",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "after-heal-body", type: "p", children: [{ text: "이 변경을 놓치지 않습니다." }] }],
          },
        },
      });
      const afterHealId = (afterHeal.structuredContent as { document: { id: string } }).document.id;
      const resumed = await client.callTool({ name: "get_changes", arguments: {} });
      expect(resumed.structuredContent).toMatchObject({
        events: [expect.objectContaining({ documentId: afterHealId })],
      });

      const benchmarkBlocks = [
        { id: "benchmark-root", type: "h1", children: [{ text: "Compact benchmark" }] },
        ...Array.from({ length: 44 }, (_, index) => ({
          id: `benchmark-before-${index}`,
          type: "p",
          children: [{ text: `Before ${index}` }],
        })),
        { id: "benchmark-target", type: "h3", children: [{ text: "Target section" }] },
        { id: "benchmark-target-body", type: "p", children: [{ text: "Unique compact edit needle" }] },
        { id: "benchmark-tail", type: "h3", children: [{ text: "Tail section" }] },
        ...Array.from({ length: 52 }, (_, index) => ({
          id: `benchmark-after-${index}`,
          type: "p",
          children: [{ text: `After ${index}` }],
        })),
      ];
      const benchmarkCreate = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "mcp-compact-benchmark-create-001",
          title: "Compact benchmark",
          content: { schemaVersion: 2, blocks: benchmarkBlocks },
        },
      });
      expect(benchmarkCreate.structuredContent).toMatchObject({
        responseMode: "summary",
        blockCount: 100,
      });
      expect(Buffer.byteLength(JSON.stringify(benchmarkCreate.structuredContent), "utf8"))
        .toBeLessThan(10_000);

      const benchmarkSearch = await client.callTool({
        name: "search_documents",
        arguments: { query: "Unique compact edit needle" },
      });
      const benchmarkMatch = (benchmarkSearch.structuredContent as {
        results: Array<{
          documentId: string;
          matches: Array<{ sectionId: string; sectionHash: string }>;
        }>;
      }).results[0];
      const benchmarkRead = await client.callTool({
        name: "get_document_markdown",
        arguments: { documentId: benchmarkMatch.documentId, sectionId: benchmarkMatch.matches[0].sectionId },
      });
      const benchmarkSection = benchmarkRead.structuredContent as {
        document: { draftVersion: number };
        selector: { sectionId: string; sectionHash: string };
      };
      const benchmarkPatchArguments = {
        documentId: benchmarkMatch.documentId,
        sectionId: benchmarkSection.selector.sectionId,
        expectedSectionHash: benchmarkSection.selector.sectionHash,
        expectedDraftVersion: benchmarkSection.document.draftVersion,
        requestId: "mcp-compact-benchmark-patch-001",
        markdown: "### Target section\n\nUnique compact edit completed",
      };
      const benchmarkPreview = await client.callTool({
        name: "patch_document_markdown",
        arguments: { ...benchmarkPatchArguments, dryRun: true },
      });
      const benchmarkCommit = await client.callTool({
        name: "patch_document_markdown",
        arguments: {
          ...benchmarkPatchArguments,
          commit: { summary: "Updated the benchmark target section." },
        },
      });
      const compactPathResults = [benchmarkSearch, benchmarkRead, benchmarkPreview, benchmarkCommit];
      expect(compactPathResults).toHaveLength(4);
      expect(compactPathResults.reduce((total, result) => (
        total + Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")
      ), 0)).toBeLessThan(30_000);
      compactPathResults.forEach((result) => {
        expect(JSON.stringify(result.structuredContent)).not.toContain('"blocks":[');
      });
      expect(benchmarkCommit.structuredContent).toMatchObject({
        responseMode: "summary",
        committedRevision: { number: 2 },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("commits a 103-block AST after document-local block IDs are reused", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Threads",
      role: "admin",
      scopes: [
        "documents:read",
        "documents:write",
        "documents:commit",
        "changes:read",
      ],
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "threads-regression-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const owner = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "threads-block-owner-create-001",
          title: "먼저 작성한 Threads 문서",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "title", type: "h1", children: [{ text: "먼저 작성한 문서" }] }],
          },
        },
      });
      expect(owner.isError).not.toBe(true);

      const target = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "threads-regression-target-create-001",
          title: "00-오늘의 소재 요약 목록",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "seed", type: "p", children: [{ text: "이전 정본" }] }],
          },
        },
      });
      const documentId = (target.structuredContent as { document: { id: string } }).document.id;
      const blocks = [
        { id: "title", type: "h1", children: [{ text: "00-오늘의 소재 요약 목록" }] },
        ...Array.from({ length: 102 }, (_, index) => ({
          id: `threads-item-${index + 1}`,
          type: index % 9 === 0 ? "h2" : "p",
          children: [{ text: `Threads 소재 ${index + 1}` }],
        })),
      ];

      const updated = await client.callTool({
        name: "update_document",
        arguments: {
          documentId,
          expectedDraftVersion: 0,
          requestId: "threads-regression-update-001",
          content: { schemaVersion: 2, blocks },
          responseMode: "full",
        },
      });
      expect(updated.isError).not.toBe(true);
      expect(updated.structuredContent).toMatchObject({
        operation: "update_document",
        draftVersion: 1,
        committedDraftVersion: 0,
        hasUncommittedChanges: true,
        blockCount: 103,
        normalization: {
          identityScope: "documentId+nodeId",
          remappedTopLevelBlockIds: 1,
          remaps: [{
            path: "/blocks/0/id",
            requestedId: "title",
            reason: "cross_document_collision",
          }],
        },
        workingDocument: {
          draftVersion: 1,
          committedDraftVersion: 0,
          content: { schemaVersion: 2 },
        },
      });
      const workingBlocks = (updated.structuredContent as {
        workingDocument: { content: { blocks: Array<{ id: string }> } };
      }).workingDocument.content.blocks;
      expect(workingBlocks).toHaveLength(103);
      expect(workingBlocks[0].id).not.toBe("title");
      const effectiveId = (updated.structuredContent as {
        normalization: { remaps: Array<{ effectiveId: string }> };
      }).normalization.remaps[0].effectiveId;
      expect(effectiveId).toBe(workingBlocks[0].id);

      const replayedUpdate = await client.callTool({
        name: "update_document",
        arguments: {
          documentId,
          expectedDraftVersion: 0,
          requestId: "threads-regression-update-001",
          content: { schemaVersion: 2, blocks },
          responseMode: "full",
        },
      });
      expect(replayedUpdate.structuredContent).toEqual(updated.structuredContent);

      const patched = await client.callTool({
        name: "patch_document",
        arguments: {
          documentId,
          expectedDraftVersion: 1,
          requestId: "threads-remapped-block-follow-up-patch-001",
          operations: [{
            op: "replace_block",
            blockId: effectiveId,
            block: { type: "h1", children: [{ text: "후속 patch가 실제 ID를 사용했습니다" }] },
          }],
          responseMode: "full",
        },
      });
      expect(patched.isError).not.toBe(true);
      expect(patched.structuredContent).toMatchObject({
        operation: "patch_document",
        draftVersion: 2,
      });
      expect((patched.structuredContent as {
        workingDocument: { content: { blocks: Array<{ id: string; children: Array<{ text: string }> }> } };
      }).workingDocument.content.blocks[0]).toMatchObject({
        id: effectiveId,
        children: [{ text: "후속 patch가 실제 ID를 사용했습니다" }],
      });

      const beforeCommit = await client.callTool({
        name: "get_document",
        arguments: { documentId },
      });
      expect(beforeCommit.structuredContent).toMatchObject({
        document: {
          revisionNumber: 1,
          content: { schemaVersion: 2 },
        },
      });
      expect((beforeCommit.structuredContent as {
        document: { content: { blocks: unknown[] } };
      }).document.content.blocks).toHaveLength(1);

      const committed = await client.callTool({
        name: "commit_document",
        arguments: {
          documentId,
          expectedDraftVersion: 2,
          requestId: "commit-test-20260730-01",
          summary: "원문과 Threads 초안 커밋",
          responseMode: "full",
        },
      });
      expect(committed.isError).not.toBe(true);
      expect(committed.structuredContent).toMatchObject({
        operation: "commit_document",
        draftVersion: 2,
        committedDraftVersion: 2,
        baseRevisionNumber: 2,
        hasUncommittedChanges: false,
        blockCount: 103,
        document: {
          id: documentId,
          revisionNumber: 2,
          content: { schemaVersion: 2 },
        },
        workingDocument: {
          draftVersion: 2,
          committedDraftVersion: 2,
          hasUncommittedChanges: false,
        },
      });
      expect((committed.structuredContent as {
        document: { content: { blocks: unknown[] } };
      }).document.content.blocks).toHaveLength(103);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("captures one idempotent handoff document and ready Agent To-dos", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Handoff agent",
      role: "admin",
      scopes: [
        "documents:read",
        "documents:write",
        "documents:commit",
        "changes:read",
      ],
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const server = createNyxdocMcpServer(database, identity);
    const client = new Client({ name: "handoff-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const arguments_ = {
      workspaceId: workspace.id,
      requestId: "capture-handoff-test-001",
      title: "에이전트 연결 논의",
      summary: "OAuth와 기존 연결 키를 함께 지원하기로 했다.",
      decisions: ["기존 Bearer 연결은 유지한다."],
      requirements: ["워크스페이스 경계를 지킨다."],
      todos: [{
        title: "OAuth 연결 검증",
        description: "원격 MCP 클라이언트 연결을 확인한다.",
        acceptanceCriteria: "get_capabilities 호출에 성공한다.",
        assignedAgentId: identity.agentId,
      }],
    };

    try {
      const before = database.prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number };
      const preview = await client.callTool({
        name: "capture_handoff",
        arguments: { ...arguments_, dryRun: true },
      });
      expect(preview.isError).not.toBe(true);
      expect(preview.structuredContent).toMatchObject({
        dryRun: true,
        startedTasks: false,
        document: { title: arguments_.title, documentType: "handoff" },
        tasks: [{ title: "OAuth 연결 검증" }],
      });
      expect((database.prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number }).count).toBe(before.count);

      const captured = await client.callTool({
        name: "capture_handoff",
        arguments: arguments_,
      });
      expect(captured.isError).not.toBe(true);
      expect(captured.structuredContent).toMatchObject({
        dryRun: false,
        startedTasks: false,
        taskCount: 1,
        document: {
          title: arguments_.title,
          revisionNumber: 1,
        },
        tasks: [{
          title: "OAuth 연결 검증",
          status: "ready",
          assignedAgentId: identity.agentId,
        }],
      });
      const replay = await client.callTool({
        name: "capture_handoff",
        arguments: arguments_,
      });
      expect(replay.structuredContent).toEqual(captured.structuredContent);
      expect((database.prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number }).count).toBe(before.count + 1);
      expect((database.prepare(
        "SELECT COUNT(*) AS count FROM document_tasks WHERE workspace_id = ?",
      ).get(workspace.id) as { count: number }).count).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lets editor agents trash only document trees they created", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Editor agent",
      role: "editor",
      scopes: ["documents:read", "documents:write"],
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "nyxdoc-own-trash-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const context = await client.callTool({
        name: "get_workspace_context",
        arguments: { workspaceId: workspace.id },
      });
      expect(context.structuredContent).toMatchObject({
        agent: {
          role: "editor",
          allowedActions: expect.arrayContaining(["documents.trash_own"]),
        },
      });
      expect((context.structuredContent as {
        agent: { allowedActions: string[] };
      }).agent.allowedActions).not.toContain("documents.trash");

      const ownDocument = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "editor-own-trash-create-001",
          title: "Editor-owned document",
          content: {
            schemaVersion: 2,
            blocks: [{
              id: "editor-own-trash-body",
              type: "p",
              children: [{ text: "The editor agent created this document." }],
            }],
          },
        },
      });
      const own = (ownDocument.structuredContent as {
        document: { id: string; revisionNumber: number };
      }).document;
      expect((await client.callTool({
        name: "trash_document",
        arguments: {
          documentId: own.id,
          baseRevision: own.revisionNumber,
        },
      })).structuredContent).toMatchObject({
        archivedDocumentIds: [own.id],
        archivedCount: 1,
      });

      const mixedParentResult = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "editor-mixed-trash-create-001",
          title: "Mixed document tree",
          content: {
            schemaVersion: 2,
            blocks: [{
              id: "editor-mixed-trash-body",
              type: "p",
              children: [{ text: "The editor agent created the parent." }],
            }],
          },
        },
      });
      const mixedParent = (mixedParentResult.structuredContent as {
        document: { id: string; revisionNumber: number };
      }).document;
      createDocument(database, workspace.id, {
        type: "human",
        userId: user.id,
        principalId: user.id,
        label: user.name,
        source: "web",
      }, {
        title: "Human-owned child",
        parentDocumentId: mixedParent.id,
        content: {
          schemaVersion: 2,
          blocks: [{
            id: "human-owned-child-body",
            type: "p",
            children: [{ text: "A human created this child document." }],
          }],
        },
      });

      const rejected = await client.callTool({
        name: "trash_document",
        arguments: {
          documentId: mixedParent.id,
          baseRevision: mixedParent.revisionNumber,
        },
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toMatchObject({
        code: "FORBIDDEN",
        documentCount: 2,
        otherCreatorCount: 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("patches and commits one Markdown section while preserving unrelated concurrent edits", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Section Agent",
      role: "admin",
      scopes: ["documents:read", "documents:write", "documents:commit"],
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "nyxdoc-section-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const created = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "section-create-document-001",
          title: "Section workflow",
          content: {
            schemaVersion: 2,
            blocks: [
              { id: "section-a", type: "h1", children: [{ text: "A" }] },
              { id: "section-a-body", type: "p", children: [{ text: "A body" }] },
              { id: "section-b", type: "h1", children: [{ text: "B" }] },
              { id: "section-b-body", type: "p", children: [{ text: "B body" }] },
            ],
          },
        },
      });
      const documentId = (created.structuredContent as { document: { id: string } }).document.id;
      const sectionRead = await client.callTool({
        name: "get_document_markdown",
        arguments: { documentId, sectionId: "section-a" },
      });
      const sectionHash = (sectionRead.structuredContent as {
        selector: { sectionHash: string };
      }).selector.sectionHash;

      await client.callTool({
        name: "patch_document",
        arguments: {
          documentId,
          expectedDraftVersion: 0,
          requestId: "section-unrelated-edit-001",
          operations: [{
            op: "replace_block",
            blockId: "section-b",
            block: { type: "h1", children: [{ text: "B changed elsewhere" }] },
          }],
        },
      });

      const strictDocumentPatch = await client.callTool({
        name: "patch_document_markdown",
        arguments: {
          documentId,
          sectionId: "section-a",
          expectedSectionHash: sectionHash,
          expectedDraftVersion: 0,
          concurrencyMode: "document",
          requestId: "section-document-lock-preview-001",
          markdown: "# A revised\n\nA body revised",
          dryRun: true,
        },
      });
      expect(strictDocumentPatch.isError).toBe(true);
      expect(strictDocumentPatch.structuredContent).toMatchObject({
        code: "DRAFT_CONFLICT",
        concurrencyMode: "document",
        expectedDraftVersion: 0,
        currentDraftVersion: 1,
      });

      const patchArguments = {
        documentId,
        sectionId: "section-a",
        expectedSectionHash: sectionHash,
        expectedDraftVersion: 0,
        requestId: "section-patch-commit-001",
        markdown: "# A revised\n\nA body revised",
        commit: { summary: "Updated only section A." },
      };
      const patched = await client.callTool({
        name: "patch_document_markdown",
        arguments: patchArguments,
      });
      expect(patched.isError).not.toBe(true);
      expect(patched.structuredContent).toMatchObject({
        resultVersion: "1",
        operation: "patch_document_markdown",
        responseMode: "summary",
        rebasedFromDraftVersion: 0,
        concurrencyMode: "section",
        sectionHashIsScopeGuard: true,
        unrelatedDraftChangesPreserved: true,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        committedRevision: { number: 2 },
        section: { sectionId: "section-a", title: "A revised" },
      });

      const canonical = await client.callTool({ name: "get_document", arguments: { documentId } });
      const canonicalBlocks = (canonical.structuredContent as {
        document: { revisionNumber: number; content: { blocks: Array<{ id: string; children: Array<{ text: string }> }> } };
      }).document;
      expect(canonicalBlocks.revisionNumber).toBe(2);
      expect(canonicalBlocks.content.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "section-a", children: [expect.objectContaining({ text: "A revised" })] }),
        expect.objectContaining({ id: "section-b", children: [expect.objectContaining({ text: "B changed elsewhere" })] }),
      ]));

      await client.callTool({ name: "patch_document_markdown", arguments: patchArguments });
      const afterReplay = await client.callTool({ name: "get_document", arguments: { documentId } });
      expect(afterReplay.structuredContent).toMatchObject({ document: { revisionNumber: 2 } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists and operates on this agent's To-dos across allowed workspaces", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const primary = createTestUser(database, {
      name: "Primary Owner",
      email: "primary-owner@example.com",
    });
    const organization = createOrganization(database, {
      userId: primary.user.id,
      actorLabel: primary.user.name,
      name: "Shared Organization",
    });
    const secondaryWorkspace = createWorkspace(
      database,
      primary.user,
      "Secondary Workspace",
      "en",
      { organizationId: organization.id },
    );
    const token = createWorkspaceToken(database, {
      workspaceId: primary.workspace.id,
      userId: primary.user.id,
      name: "Global task agent",
      role: "admin",
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const secondaryMembershipId = assignAgentToWorkspace(database, {
      userId: primary.user.id,
      workspaceId: secondaryWorkspace.id,
      agentId: identity.globalAgentId,
      role: "admin",
    }).membershipId;

    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "nyxdoc-global-task-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const availableWorkspaces = await client.callTool({
        name: "list_agent_workspaces",
        arguments: {},
      });
      expect(availableWorkspaces.structuredContent).toMatchObject({
        workspaces: expect.arrayContaining([
          expect.objectContaining({
            id: secondaryWorkspace.id,
            namespace: {
              type: "organization",
              id: organization.id,
              name: organization.name,
            },
          }),
        ]),
      });

      const primaryTask = (await client.callTool({
        name: "create_task",
        arguments: {
          requestId: "global-task-primary-001",
          workspaceId: primary.workspace.id,
          title: "Primary workspace task",
          assignedAgentId: identity.agentId,
        },
      })).structuredContent as { task: { id: string } };
      const secondaryTask = (await client.callTool({
        name: "create_task",
        arguments: {
          requestId: "global-task-secondary-001",
          workspaceId: secondaryWorkspace.id,
          title: "Secondary workspace task",
          assignedAgentId: secondaryMembershipId,
        },
      })).structuredContent as { task: { id: string; version: number } };
      await client.callTool({
        name: "create_task",
        arguments: {
          requestId: "global-task-unassigned-001",
          workspaceId: secondaryWorkspace.id,
          title: "Unassigned workspace task",
        },
      });

      const assigned = (await client.callTool({
        name: "list_my_tasks",
        arguments: {},
      })).structuredContent as {
        tasks: Array<{
          id: string;
          workspaceId: string;
          workspaceName: string;
          workspaceSlug: string;
        }>;
        total: number;
        scope: string;
        workspaceFilter: string | null;
        includesUnassigned: boolean;
      };
      expect(assigned).toMatchObject({
        total: 2,
        scope: "global_agent",
        workspaceFilter: null,
        includesUnassigned: false,
      });
      expect(assigned.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: primaryTask.task.id,
          workspaceId: primary.workspace.id,
          workspaceName: primary.workspace.name,
          workspaceSlug: primary.workspace.slug,
        }),
        expect.objectContaining({
          id: secondaryTask.task.id,
          workspaceId: secondaryWorkspace.id,
          workspaceName: secondaryWorkspace.name,
          workspaceSlug: secondaryWorkspace.slug,
        }),
      ]));

      expect((await client.callTool({
        name: "list_my_tasks",
        arguments: {
          workspaceId: secondaryWorkspace.id,
          includeUnassigned: true,
        },
      })).structuredContent).toMatchObject({
        total: 2,
        scope: "global_agent",
        workspaceFilter: secondaryWorkspace.id,
        includesUnassigned: true,
      });

      expect((await client.callTool({
        name: "get_task",
        arguments: { taskId: secondaryTask.task.id },
      })).structuredContent).toMatchObject({
        task: {
          id: secondaryTask.task.id,
          workspaceId: secondaryWorkspace.id,
          workspaceName: secondaryWorkspace.name,
        },
        canClaim: true,
      });

      const claimed = await client.callTool({
        name: "claim_task",
        arguments: {
          taskId: secondaryTask.task.id,
          expectedVersion: secondaryTask.task.version,
          requestId: "global-task-claim-secondary-001",
          message: "현재 연결 워크스페이스를 바꾸지 않고 작업을 시작합니다.",
        },
      });
      expect(claimed.structuredContent).toMatchObject({
        task: {
          id: secondaryTask.task.id,
          workspaceId: secondaryWorkspace.id,
          assignedAgentId: secondaryMembershipId,
          status: "in_progress",
          version: 2,
        },
      });
      expect((await client.callTool({
        name: "report_task",
        arguments: {
          taskId: secondaryTask.task.id,
          expectedVersion: 2,
          requestId: "global-task-report-secondary-001",
          status: "in_progress",
          progress: 20,
          message: "다중 워크스페이스 작업 경계를 확인했습니다.",
        },
      })).structuredContent).toMatchObject({
        task: {
          workspaceId: secondaryWorkspace.id,
          status: "in_progress",
          progress: 20,
          version: 3,
        },
      });

      const crossWorkspaceRequestId = "global-task-cross-workspace-idempotency-001";
      await client.callTool({
        name: "create_task",
        arguments: {
          requestId: crossWorkspaceRequestId,
          workspaceId: primary.workspace.id,
          title: "Workspace-bound idempotency",
        },
      });
      const reusedAcrossWorkspace = await client.callTool({
        name: "create_task",
        arguments: {
          requestId: crossWorkspaceRequestId,
          workspaceId: secondaryWorkspace.id,
          title: "Workspace-bound idempotency",
        },
      });
      expect(reusedAcrossWorkspace.isError).toBe(true);
      expect(reusedAcrossWorkspace.structuredContent).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses the persisted public base URL for human-facing document links", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database, { name: "Site owner" });
    ensureSiteAdministratorBootstrap(database, user);
    updateSiteSettings(database, user, {
      expectedVersion: 0,
      publicBaseUrl: "https://docs.example.test/install/",
      registrationMode: "invite",
      emailVerificationEnabled: false,
      emailDomainPolicy: "any",
      allowedEmailDomains: [],
      smtp: {
        host: "",
        port: 587,
        secure: false,
        user: "",
        from: "",
      },
    });
    const token = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Link agent",
      role: "editor",
      scopes: ["documents:read", "documents:write"],
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "nyxdoc-link-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const created = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "persisted-public-url-document",
          title: "Public URL contract",
          content: {
            schemaVersion: 2,
            blocks: [{ id: "public-url", type: "p", children: [{ text: "Linked" }] }],
          },
        },
      });
      const documentId = (created.structuredContent as { document: { id: string } })
        .document.id;
      const expected = `https://docs.example.test/app?workspace=${workspace.id}&document=${documentId}`;
      expect(created.structuredContent).toMatchObject({
        webUrl: expected,
        document: { id: documentId, webUrl: expected },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes document tools across allowed workspaces without changing the connection default", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const primary = createTestUser(database, {
      name: "Multi workspace owner",
      email: "multi-workspace-owner@example.com",
    });
    const secondaryWorkspace = createWorkspace(
      database,
      primary.user,
      "Secondary Documents",
      "en",
    );
    const unassignedWorkspace = createWorkspace(
      database,
      primary.user,
      "Unassigned Documents",
      "en",
    );
    const token = createWorkspaceToken(database, {
      workspaceId: primary.workspace.id,
      userId: primary.user.id,
      name: "Multi workspace agent",
      role: "admin",
      scopes: [
        "documents:read",
        "documents:write",
        "documents:commit",
        "changes:read",
        "revisions:restore",
      ],
    });
    const identity = authenticateApiToken(database, `Bearer ${token.token}`);
    const secondaryMembershipId = assignAgentToWorkspace(database, {
      userId: primary.user.id,
      workspaceId: secondaryWorkspace.id,
      agentId: identity.globalAgentId,
      role: "admin",
    }).membershipId;
    const collaboration = createCollaborationCommands({
      database,
      provider: createStoredCollaborationDocumentProvider(database),
    });
    const server = createNyxdocMcpServer(database, identity, collaboration);
    const client = new Client({ name: "nyxdoc-multi-workspace-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const content = (id: string, text: string) => ({
      schemaVersion: 2,
      blocks: [{ id, type: "p", children: [{ text }] }],
    });

    try {
      const primaryCreated = (await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "multi-workspace-primary-document",
          title: "Primary document",
          content: content("primary-block", "Only in the primary workspace"),
        },
      })).structuredContent as { workspaceId: string; document: { id: string } };
      expect(primaryCreated.workspaceId).toBe(primary.workspace.id);

      const secondaryCreated = (await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "multi-workspace-secondary-document",
          workspaceId: secondaryWorkspace.id,
          title: "Secondary document",
          content: content("secondary-block", "Searchable secondary workspace text"),
        },
      })).structuredContent as { workspaceId: string; document: { id: string } };
      expect(secondaryCreated.workspaceId).toBe(secondaryWorkspace.id);
      const secondaryWebUrl = getDocumentWebUrl(
        secondaryWorkspace.id,
        secondaryCreated.document.id,
      );

      expect((await client.callTool({
        name: "get_document",
        arguments: { documentId: secondaryCreated.document.id },
      })).structuredContent).toMatchObject({
        workspaceId: secondaryWorkspace.id,
        webUrl: secondaryWebUrl,
        document: {
          id: secondaryCreated.document.id,
          title: "Secondary document",
          webUrl: secondaryWebUrl,
        },
      });

      expect((await client.callTool({
        name: "list_documents",
        arguments: { workspaceId: secondaryWorkspace.id },
      })).structuredContent).toMatchObject({
        workspaceId: secondaryWorkspace.id,
        documents: expect.arrayContaining([
          expect.objectContaining({
            id: secondaryCreated.document.id,
            webUrl: secondaryWebUrl,
          }),
        ]),
      });

      expect((await client.callTool({
        name: "search_documents",
        arguments: {
          workspaceId: secondaryWorkspace.id,
          query: "Searchable secondary",
        },
      })).structuredContent).toMatchObject({
        workspaceId: secondaryWorkspace.id,
        results: expect.arrayContaining([
          expect.objectContaining({
            documentId: secondaryCreated.document.id,
            webUrl: secondaryWebUrl,
          }),
        ]),
      });

      const secondaryChild = (await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "multi-workspace-inferred-child",
          title: "Inferred secondary child",
          parentDocumentId: secondaryCreated.document.id,
          content: content("secondary-child-block", "The parent infers the workspace"),
        },
      })).structuredContent as { workspaceId: string; document: { id: string } };
      expect(secondaryChild.workspaceId).toBe(secondaryWorkspace.id);
      const secondarySibling = (await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "multi-workspace-outside-root",
          workspaceId: secondaryWorkspace.id,
          title: "Outside the later document root",
          parentDocumentId: null,
          content: content("secondary-sibling-block", "Outside the later root"),
        },
      })).structuredContent as { document: { id: string } };

      expect((await client.callTool({
        name: "batch_get_documents",
        arguments: {
          documentIds: [primaryCreated.document.id, secondaryChild.document.id],
        },
      })).structuredContent).toMatchObject({
        documents: expect.arrayContaining([
          expect.objectContaining({
            id: primaryCreated.document.id,
            workspaceId: primary.workspace.id,
            webUrl: getDocumentWebUrl(primary.workspace.id, primaryCreated.document.id),
          }),
          expect.objectContaining({
            id: secondaryChild.document.id,
            workspaceId: secondaryWorkspace.id,
            webUrl: getDocumentWebUrl(secondaryWorkspace.id, secondaryChild.document.id),
          }),
        ]),
      });

      expect((await client.callTool({
        name: "get_workspace_context",
        arguments: { workspaceId: secondaryWorkspace.id },
      })).structuredContent).toMatchObject({
        workspace: { id: secondaryWorkspace.id },
        agent: { membershipId: secondaryMembershipId, role: "admin" },
      });

      const mismatch = await client.callTool({
        name: "create_document",
        arguments: {
          requestId: "multi-workspace-mismatched-parent",
          workspaceId: primary.workspace.id,
          title: "Must not cross boundaries",
          parentDocumentId: secondaryCreated.document.id,
          content: content("mismatch-block", "Rejected"),
        },
      });
      expect(mismatch.isError).toBe(true);
      expect(mismatch.structuredContent).toMatchObject({ code: "INVALID_INPUT" });

      const unassigned = await client.callTool({
        name: "list_documents",
        arguments: { workspaceId: unassignedWorkspace.id },
      });
      expect(unassigned.isError).toBe(true);

      database.prepare(
        "UPDATE workspace_agents SET root_document_id = ? WHERE id = ?",
      ).run(secondaryCreated.document.id, secondaryMembershipId);
      expect((await client.callTool({
        name: "get_document",
        arguments: { documentId: secondaryChild.document.id },
      })).isError).not.toBe(true);
      const outsideDocumentRoot = await client.callTool({
        name: "get_document",
        arguments: { documentId: secondarySibling.document.id },
      });
      expect(outsideDocumentRoot.isError).toBe(true);

      database.prepare(
        "UPDATE workspace_agents SET status = 'disabled' WHERE id = ?",
      ).run(secondaryMembershipId);
      const disabledMembership = await client.callTool({
        name: "get_document",
        arguments: { documentId: secondaryCreated.document.id },
      });
      expect(disabledMembership.isError).toBe(true);

      expect((await client.callTool({
        name: "list_agent_workspaces",
        arguments: {},
      })).structuredContent).toMatchObject({
        defaultWorkspaceId: primary.workspace.id,
        workspaces: [expect.objectContaining({
          id: primary.workspace.id,
          default: true,
        })],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
