import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { restoreWorkspace } from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { workspaceId } = await context.params;
    const workspace = restoreWorkspace(sqlite, {
      workspaceId,
      userId: session.user.id,
      actorLabel: session.user.name,
    });
    return Response.json(
      { workspace },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
