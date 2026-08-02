import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  removeOrganizationMember,
  updateOrganizationMemberRole,
} from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
  userId: z.string().min(1).max(200),
});
const updateSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ organizationId: string; userId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const params = paramsSchema.parse(await context.params);
    const body = updateSchema.parse(await request.json());
    return Response.json({
      member: updateOrganizationMemberRole(sqlite, {
        organizationId: params.organizationId,
        userId: session.user.id,
        targetUserId: params.userId,
        role: body.role,
        actorLabel: session.user.name,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ organizationId: string; userId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const params = paramsSchema.parse(await context.params);
    removeOrganizationMember(sqlite, {
      organizationId: params.organizationId,
      userId: session.user.id,
      targetUserId: params.userId,
      actorLabel: session.user.name,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
