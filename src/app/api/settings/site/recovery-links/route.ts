import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { createPasswordRecoveryLink } from "@/lib/site-settings/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const recoverySchema = z.object({
  userId: z.string().min(1).max(200),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const body = recoverySchema.parse(await request.json());
    return Response.json(
      createPasswordRecoveryLink(sqlite, {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }, body.userId),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
