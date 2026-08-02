import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { trashWorkspace } from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const trashSchema = z.object({
  confirmationName: z.string().trim().min(1).max(120),
});

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { workspaceId } = await context.params;
    const body = trashSchema.parse(await request.json());
    const result = trashWorkspace(sqlite, {
      workspaceId,
      userId: session.user.id,
      actorLabel: session.user.name,
      confirmationName: body.confirmationName,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
