import { requireWorkspaceSession } from "@/data/workspace-context";
import { reviewAdminActionSchema } from "@/lib/admin-requests/schemas";
import { reviewAdminAction } from "@/lib/admin-requests/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const { requestId } = await context.params;
    const body = reviewAdminActionSchema.parse(await request.json());
    const result = reviewAdminAction(
      sqlite,
      workspace.id,
      {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
      requestId,
      body,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
