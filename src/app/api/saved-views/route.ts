import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { createSavedViewSchema } from "@/lib/collaboration/schemas";
import { createSavedView, listSavedViews } from "@/lib/collaboration/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "saved_views.read");
    const actor = { type: "human" as const, userId: session.user.id, label: session.user.name };
    return Response.json({ views: listSavedViews(sqlite, workspace.id, actor) }, {
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
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "saved_views.manage");
    const body = createSavedViewSchema.parse(await request.json());
    const view = createSavedView(
      sqlite,
      workspace.id,
      { type: "human", userId: session.user.id, label: session.user.name },
      body,
    );
    return Response.json({ view }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
