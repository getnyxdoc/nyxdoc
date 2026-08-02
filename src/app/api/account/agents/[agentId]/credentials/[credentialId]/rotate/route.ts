import { requireVerifiedSession } from "@/data/session";
import { rotateAgentCredential } from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ agentId: string; credentialId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId, credentialId } = await context.params;
    return Response.json(rotateAgentCredential(sqlite, {
      userId: session.user.id,
      agentId,
      credentialId,
    }), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
