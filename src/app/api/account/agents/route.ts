import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { createAccountAgent, listPersonalAgents } from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ displayName: z.string().trim().min(1).max(80) });

export async function GET() {
  try {
    const session = await requireVerifiedSession();
    return Response.json({ agents: listPersonalAgents(sqlite, session.user.id) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const body = createSchema.parse(await request.json());
    return Response.json({
      agent: createAccountAgent(sqlite, { userId: session.user.id, displayName: body.displayName }),
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
