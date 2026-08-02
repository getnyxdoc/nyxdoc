import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  deleteOrganizationTeam,
  updateOrganizationTeam,
} from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ organizationId: string; teamId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const params = paramsSchema.parse(await context.params);
    const body = updateSchema.parse(await request.json());
    return Response.json({
      team: updateOrganizationTeam(sqlite, {
        ...params,
        ...body,
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
  context: { params: Promise<{ organizationId: string; teamId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const params = paramsSchema.parse(await context.params);
    deleteOrganizationTeam(sqlite, {
      ...params,
      userId: session.user.id,
      actorLabel: session.user.name,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
