import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { revokeOrganizationInvitation } from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
  invitationId: z.string().uuid(),
});

export async function DELETE(
  request: Request,
  context: { params: Promise<{ organizationId: string; invitationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const params = paramsSchema.parse(await context.params);
    revokeOrganizationInvitation(sqlite, {
      ...params,
      userId: session.user.id,
      actorLabel: session.user.name,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
