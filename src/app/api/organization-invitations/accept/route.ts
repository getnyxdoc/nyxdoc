import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { acceptOrganizationInvitation } from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const acceptSchema = z.object({ token: z.string().min(16).max(256) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const body = acceptSchema.parse(await request.json());
    return Response.json({
      membership: acceptOrganizationInvitation(sqlite, {
        token: body.token,
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
        },
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
