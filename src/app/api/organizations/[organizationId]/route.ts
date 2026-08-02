import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  loadOrganizationView,
  trashOrganization,
  updateOrganization,
} from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ organizationId: z.string().uuid() });
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  icon: z.string().max(16).nullable().optional(),
}).refine((value) => value.name !== undefined || value.icon !== undefined);
const trashSchema = z.object({ confirmationName: z.string().min(1).max(120) });

export async function GET(
  _request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    return Response.json({
      view: loadOrganizationView(sqlite, organizationId, session.user.id),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    const body = updateSchema.parse(await request.json());
    return Response.json({
      organization: updateOrganization(sqlite, {
        organizationId,
        userId: session.user.id,
        actorLabel: session.user.name,
        ...body,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    const body = trashSchema.parse(await request.json());
    return Response.json({
      organization: trashOrganization(sqlite, {
        organizationId,
        userId: session.user.id,
        actorLabel: session.user.name,
        confirmationName: body.confirmationName,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
