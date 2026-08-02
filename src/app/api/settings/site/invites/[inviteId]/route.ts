import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  listSiteInvites,
  revokeSiteInvite,
} from "@/lib/site-settings/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ inviteId: z.string().uuid() });

export async function DELETE(
  request: Request,
  context: { params: Promise<{ inviteId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { inviteId } = paramsSchema.parse(await context.params);
    revokeSiteInvite(sqlite, {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }, inviteId);
    return Response.json(
      { invites: listSiteInvites(sqlite) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
