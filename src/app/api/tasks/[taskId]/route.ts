import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { updateDocumentTaskSchema } from "@/lib/tasks/schemas";
import {
  getDocumentTask,
  listDocumentTaskEvents,
  updateDocumentTask,
} from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "tasks.read");
    const { taskId } = await context.params;
    return Response.json({
      task: getDocumentTask(sqlite, workspace.id, taskId),
      events: listDocumentTaskEvents(sqlite, workspace.id, taskId),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "tasks.update");
    const { taskId } = await context.params;
    const body = updateDocumentTaskSchema.parse(await request.json());
    const task = updateDocumentTask(
      sqlite,
      workspace.id,
      taskId,
      humanDocumentActor(session.user),
      body,
    );
    return Response.json({ task });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "tasks.update");
    const { taskId } = await context.params;
    const current = getDocumentTask(sqlite, workspace.id, taskId);
    const task = updateDocumentTask(
      sqlite,
      workspace.id,
      taskId,
      humanDocumentActor(session.user),
      { expectedVersion: current.version, status: "cancelled" },
    );
    return Response.json({ task });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
