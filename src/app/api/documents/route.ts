import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { createDocumentSchema } from "@/lib/documents/schemas";
import { createDocument, listDocuments } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { listHumanGrantedDocuments } from "@/lib/sharing/access";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    if (workspace.accessSource === "membership") {
      requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.read");
    }
    const documents = workspace.accessSource === "membership"
      ? listDocuments(sqlite, workspace.id)
      : listHumanGrantedDocuments(sqlite, workspace.id, session.user.id);
    return Response.json(
      { documents },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.create");
    const body = createDocumentSchema.parse(await request.json());
    const result = createDocument(
      sqlite,
      workspace.id,
      humanDocumentActor(session.user),
      body,
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
