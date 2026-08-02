import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  addOrganizationTeamMember,
  removeOrganizationTeamMember,
} from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  userId: z.string().min(1).max(200),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ organizationId: string; teamId: string; userId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const params = paramsSchema.parse(await context.params);
    return Response.json({
      team: addOrganizationTeamMember(sqlite, {
        organizationId: params.organizationId,
        teamId: params.teamId,
        targetUserId: params.userId,
        userId: session.user.id,
        actorLabel: session.user.name,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ organizationId: string; teamId: string; userId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const params = paramsSchema.parse(await context.params);
    removeOrganizationTeamMember(sqlite, {
      organizationId: params.organizationId,
      teamId: params.teamId,
      targetUserId: params.userId,
      userId: session.user.id,
      actorLabel: session.user.name,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
