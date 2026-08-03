import { requireVerifiedSession } from "@/data/session";
import { agentIdentityIdSchema } from "@/lib/agents/identifiers";
import { restoreAccountAgent } from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId: rawAgentId } = await context.params;
    const agentId = agentIdentityIdSchema.parse(rawAgentId);
    return Response.json({
      agent: restoreAccountAgent(sqlite, { userId: session.user.id, agentId }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
