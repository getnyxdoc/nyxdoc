import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  createSiteInvite,
  listSiteInvites,
  requireSiteAdministrator,
} from "@/lib/site-settings/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createInviteSchema = z.object({
  email: z.string().trim().email().max(320),
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
}).strict();

export async function GET() {
  try {
    const session = await requireVerifiedSession();
    requireSiteAdministrator(sqlite, {
      id: session.user.id,
      email: session.user.email,
    });
    return Response.json(
      { invites: listSiteInvites(sqlite) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const body = createInviteSchema.parse(await request.json());
    const result = createSiteInvite(sqlite, {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }, body);
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
