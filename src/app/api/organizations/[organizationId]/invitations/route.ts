import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  createOrganizationInvitation,
  listOrganizationInvitations,
} from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ organizationId: z.string().uuid() });
const createSchema = z.object({
  email: z.string().trim().email().max(254).nullable().optional(),
  role: z.enum(["admin", "member"]).default("member"),
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    return Response.json({
      invitations: listOrganizationInvitations(sqlite, organizationId, session.user.id),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    const body = createSchema.parse(await request.json());
    const created = createOrganizationInvitation(sqlite, {
      organizationId,
      userId: session.user.id,
      actorLabel: session.user.name,
      ...body,
    });
    return Response.json(created, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
