import { z } from "zod";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { updateWorkspaceName } from "@/lib/settings/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = updateWorkspaceSchema.parse(await request.json());
    const updated = body.name === workspace.name
      ? { id: workspace.id, name: workspace.name, updatedAt: workspace.updatedAt }
      : updateWorkspaceName(sqlite, workspace.id, session.user.id, body.name);
    return Response.json(
      { workspace: updated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
