import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import {
  createOrganizationAgent,
  listOrganizationAgents,
} from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ organizationId: z.string().uuid() });
const createSchema = z.object({ displayName: z.string().trim().min(1).max(80) });

export async function GET(
  _request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    return Response.json({
      agents: listOrganizationAgents(sqlite, organizationId, session.user.id),
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
    return Response.json({
      agent: createOrganizationAgent(sqlite, {
        organizationId,
        userId: session.user.id,
        actorLabel: session.user.name,
        displayName: body.displayName,
      }),
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
