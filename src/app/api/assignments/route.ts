import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { assignmentQuerySchema, createAssignmentSchema } from "@/lib/collaboration/schemas";
import { assignDocument, listAssignments } from "@/lib/collaboration/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "assignments.read");
    const url = new URL(request.url);
    const query = assignmentQuerySchema.parse({
      documentId: url.searchParams.get("documentId") ?? undefined,
      agentId: url.searchParams.get("agentId") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    });
    return Response.json({ assignments: listAssignments(sqlite, workspace.id, query) }, {
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
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "assignments.manage");
    const body = createAssignmentSchema.parse(await request.json());
    const assignment = assignDocument(
      sqlite,
      workspace.id,
      { type: "human", userId: session.user.id, label: session.user.name },
      body,
    );
    return Response.json({ assignment, grantsAccess: false }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
