import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  createDocumentTaskSchema,
  documentTaskQuerySchema,
} from "@/lib/tasks/schemas";
import {
  createDocumentTask,
  listDocumentTasks,
} from "@/lib/tasks/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "tasks.read");
    const url = new URL(request.url);
    const assigned = url.searchParams.get("assignedAgentId");
    const target = url.searchParams.get("targetDocumentId");
    const query = documentTaskQuerySchema.parse({
      status: url.searchParams.get("status") ?? undefined,
      priority: url.searchParams.get("priority") ?? undefined,
      assignedAgentId: assigned === "unassigned" ? null : assigned ?? undefined,
      targetDocumentId: target === "workspace" ? null : target ?? undefined,
      openOnly: url.searchParams.has("openOnly")
        ? url.searchParams.get("openOnly") === "true"
        : undefined,
      offset: url.searchParams.has("offset")
        ? Number(url.searchParams.get("offset"))
        : undefined,
      limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
    });
    return Response.json(listDocumentTasks(sqlite, workspace.id, query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "tasks.create");
    const body = createDocumentTaskSchema.omit({ requestId: true }).parse(await request.json());
    const task = createDocumentTask(
      sqlite,
      workspace.id,
      humanDocumentActor(session.user),
      body,
    );
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
