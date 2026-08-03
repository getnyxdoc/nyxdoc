import { afterEach, describe, expect, it } from "vitest";
import type { NyxDatabase } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import {
  claimDocumentTask,
  completeDocumentTask,
  createDocumentTask,
  getDocumentTask,
  listDocumentTaskEvents,
  listDocumentTasks,
  reportDocumentTask,
  updateDocumentTask,
} from "@/lib/tasks/service";
import { TaskServiceError } from "@/lib/tasks/types";
import {
  authenticateApiToken,
  createWorkspaceToken,
  tokenDocumentActor,
} from "@/lib/tokens/service";
import { createTestDatabase, createTestUser } from "@/test/fixture";

const databases: NyxDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("document task service", () => {
  it("rejects direct task actions after the credential grant binding is revoked", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const connection = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Unbound task agent",
      role: "editor",
    });
    const identity = authenticateApiToken(database, `Bearer ${connection.token}`);
    const task = createDocumentTask(
      database,
      workspace.id,
      humanDocumentActor(user),
      { title: "Binding-protected task", assignedAgentId: identity.agentId },
    );
    database.prepare(
      `UPDATE agent_credential_grant_bindings
       SET status = 'revoked', revoked_at = ?
       WHERE credential_id = ?`,
    ).run("2026-08-03T00:00:00.000Z", identity.id);

    expect(() => claimDocumentTask(
      database,
      workspace.id,
      task.id,
      tokenDocumentActor(identity, "mcp"),
      {
        expectedVersion: task.version,
        requestId: "unbound-task-claim-001",
      },
    )).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("carries a human request through agent claim, progress, review, and acceptance", () => {
    const database = createTestDatabase();
    databases.push(database);
    const { user, workspace } = createTestUser(database);
    const document = database.prepare(
      `SELECT document.id, revision.revision_number
       FROM documents document
       JOIN document_revisions revision ON revision.id = document.current_revision_id
       WHERE document.workspace_id = ?
       ORDER BY document.created_at LIMIT 1`,
    ).get(workspace.id) as { id: string; revision_number: number };
    const connection = createWorkspaceToken(database, {
      workspaceId: workspace.id,
      userId: user.id,
      name: "Task agent",
      role: "editor",
    });
    const identity = authenticateApiToken(database, `Bearer ${connection.token}`);
    const human = humanDocumentActor(user);
    const agent = tokenDocumentActor(identity, "mcp");

    const created = createDocumentTask(database, workspace.id, human, {
      title: "운영 문서 최신화",
      description: "현재 절차를 확인하고 빠진 단계를 보강합니다.",
      acceptanceCriteria: "변경 근거와 결과 리비전을 남깁니다.",
      targetDocumentId: document.id,
      requiresReview: true,
      priority: "high",
    });

    expect(created).toMatchObject({
      status: "ready",
      priority: "high",
      progress: 0,
      assignedAgentId: null,
      targetDocumentId: document.id,
      targetDocumentPath: expect.arrayContaining([
        expect.objectContaining({ id: document.id }),
      ]),
      requiresReview: true,
      version: 1,
    });
    expect(listDocumentTasks(database, workspace.id, { openOnly: true })).toMatchObject({
      total: 1,
      tasks: [{ id: created.id }],
    });

    const claimInput = {
      expectedVersion: created.version,
      requestId: "task-claim-scenario-001",
      message: "작업을 시작합니다.",
    };
    const claimed = claimDocumentTask(database, workspace.id, created.id, agent, claimInput);
    expect(claimed).toMatchObject({
      status: "in_progress",
      assignedAgentId: identity.agentId,
      assignedAgentDisplayName: "Task agent",
      version: 2,
    });
    expect(claimDocumentTask(database, workspace.id, created.id, agent, claimInput)).toEqual(claimed);

    const blocked = reportDocumentTask(database, workspace.id, created.id, agent, {
      expectedVersion: claimed.version,
      requestId: "task-report-blocked-001",
      status: "blocked",
      progress: 35,
      message: "근거 문서의 날짜를 확인해야 합니다.",
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      progress: 35,
      blocker: "근거 문서의 날짜를 확인해야 합니다.",
      version: 3,
    });

    const resumed = reportDocumentTask(database, workspace.id, created.id, agent, {
      expectedVersion: blocked.version,
      requestId: "task-report-resumed-001",
      status: "in_progress",
      progress: 70,
      message: "날짜를 확인해 작업을 계속합니다.",
    });
    expect(resumed).toMatchObject({
      status: "in_progress",
      progress: 70,
      blocker: null,
      version: 4,
    });

    const completed = completeDocumentTask(database, workspace.id, created.id, agent, {
      expectedVersion: resumed.version,
      requestId: "task-complete-scenario-001",
      resultSummary: "절차와 근거를 최신 상태로 정리했습니다.",
      resultDocumentId: document.id,
      resultRevisionNumber: document.revision_number,
    });
    expect(completed).toMatchObject({
      status: "review",
      progress: 100,
      resultSummary: "절차와 근거를 최신 상태로 정리했습니다.",
      resultDocumentId: document.id,
      resultRevisionNumber: document.revision_number,
      completedAt: null,
      version: 5,
    });

    const accepted = updateDocumentTask(database, workspace.id, created.id, human, {
      expectedVersion: completed.version,
      status: "completed",
    });
    expect(accepted).toMatchObject({
      status: "completed",
      completedAt: expect.any(String),
      version: 6,
    });
    expect(listDocumentTaskEvents(database, workspace.id, created.id).map((event) => event.eventType))
      .toEqual(["completed", "submitted", "progress", "blocked", "claimed", "created"]);
    expect(database.prepare(
      "SELECT action FROM workspace_audit_events WHERE target_id = ? ORDER BY cursor",
    ).all(created.id)).toEqual([
      { action: "task.created" },
      { action: "task.claimed" },
      { action: "task.progress_reported" },
      { action: "task.progress_reported" },
      { action: "task.submitted" },
      { action: "task.updated" },
    ]);
  });

  it("protects assignment ownership, optimistic versions, boundaries, and request IDs", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First" });
    const second = createTestUser(database, { name: "Second" });
    const firstConnection = createWorkspaceToken(database, {
      workspaceId: first.workspace.id,
      userId: first.user.id,
      name: "First agent",
      role: "editor",
    });
    const otherConnection = createWorkspaceToken(database, {
      workspaceId: first.workspace.id,
      userId: first.user.id,
      name: "Other agent",
      role: "editor",
    });
    const firstIdentity = authenticateApiToken(database, `Bearer ${firstConnection.token}`);
    const otherIdentity = authenticateApiToken(database, `Bearer ${otherConnection.token}`);
    const task = createDocumentTask(
      database,
      first.workspace.id,
      humanDocumentActor(first.user),
      {
        title: "할당 보호",
        assignedAgentId: firstIdentity.agentId,
      },
    );

    expect(() => claimDocumentTask(
      database,
      first.workspace.id,
      task.id,
      tokenDocumentActor(otherIdentity, "mcp"),
      {
        expectedVersion: task.version,
        requestId: "task-other-agent-001",
      },
    )).toThrowError(TaskServiceError);

    const claimed = claimDocumentTask(
      database,
      first.workspace.id,
      task.id,
      tokenDocumentActor(firstIdentity, "mcp"),
      {
        expectedVersion: task.version,
        requestId: "task-first-agent-001",
      },
    );
    expect(() => updateDocumentTask(
      database,
      first.workspace.id,
      task.id,
      humanDocumentActor(first.user),
      {
        expectedVersion: task.version,
        title: "오래된 변경",
      },
    )).toThrowError(/최신 상태/);

    expect(() => reportDocumentTask(
      database,
      first.workspace.id,
      task.id,
      tokenDocumentActor(firstIdentity, "mcp"),
      {
        expectedVersion: claimed.version,
        requestId: "task-first-agent-001",
        status: "in_progress",
        progress: 20,
      },
    )).toThrowError(/같은 requestId/);

    const foreignDocument = database.prepare(
      "SELECT id FROM documents WHERE workspace_id = ? LIMIT 1",
    ).get(second.workspace.id) as { id: string };
    expect(() => createDocumentTask(
      database,
      first.workspace.id,
      humanDocumentActor(first.user),
      {
        title: "경계 위반",
        targetDocumentId: foreignDocument.id,
      },
    )).toThrowError(/대상 문서/);

    expect(getDocumentTask(database, first.workspace.id, task.id).version).toBe(claimed.version);
  });

  it("binds uploaded screenshots to task fields and enforces workspace boundaries", () => {
    const database = createTestDatabase();
    databases.push(database);
    const first = createTestUser(database, { name: "First" });
    const second = createTestUser(database, { name: "Second" });
    const insertMedia = database.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, storage_key, sha256, mime_type, byte_size,
        original_filename, uploaded_by_user_id, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 128, ?, ?, '2026-07-20T00:00:00.000Z')`,
    );
    insertMedia.run(
      "11111111-1111-4111-8111-111111111111",
      first.workspace.id,
      "11/first.png",
      "1".repeat(64),
      "first.png",
      first.user.id,
    );
    insertMedia.run(
      "22222222-2222-4222-8222-222222222222",
      first.workspace.id,
      "22/criteria.png",
      "2".repeat(64),
      "criteria.png",
      first.user.id,
    );
    insertMedia.run(
      "33333333-3333-4333-8333-333333333333",
      second.workspace.id,
      "33/foreign.png",
      "3".repeat(64),
      "foreign.png",
      second.user.id,
    );

    const created = createDocumentTask(
      database,
      first.workspace.id,
      humanDocumentActor(first.user),
      {
        title: "스크린샷이 있는 작업",
        attachments: [
          {
            mediaId: "11111111-1111-4111-8111-111111111111",
            field: "description",
          },
          {
            mediaId: "22222222-2222-4222-8222-222222222222",
            field: "acceptance_criteria",
          },
        ],
      },
    );

    expect(created.attachments).toMatchObject([
      {
        mediaId: "22222222-2222-4222-8222-222222222222",
        field: "acceptance_criteria",
        position: 0,
        originalFilename: "criteria.png",
      },
      {
        mediaId: "11111111-1111-4111-8111-111111111111",
        field: "description",
        position: 0,
        originalFilename: "first.png",
      },
    ]);

    const updated = updateDocumentTask(
      database,
      first.workspace.id,
      created.id,
      humanDocumentActor(first.user),
      {
        expectedVersion: created.version,
        attachments: [{
          mediaId: "11111111-1111-4111-8111-111111111111",
          field: "acceptance_criteria",
        }],
      },
    );
    expect(updated.attachments).toMatchObject([{
      mediaId: "11111111-1111-4111-8111-111111111111",
      field: "acceptance_criteria",
      position: 0,
    }]);
    expect(() => updateDocumentTask(
      database,
      first.workspace.id,
      created.id,
      humanDocumentActor(first.user),
      {
        expectedVersion: updated.version,
        attachments: [{
          mediaId: "33333333-3333-4333-8333-333333333333",
          field: "description",
        }],
      },
    )).toThrow(/현재 워크스페이스/);
  });
});
