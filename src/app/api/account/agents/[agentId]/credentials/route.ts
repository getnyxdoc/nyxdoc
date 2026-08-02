import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { createAgentCredential } from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { API_TOKEN_SCOPES } from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(API_TOKEN_SCOPES.length).optional(),
  defaultWorkspaceId: z.string().uuid().nullable().optional(),
  workspaceAllowlist: z.array(z.string().uuid()).max(100).optional(),
  ipAllowlist: z.array(z.string().max(80)).max(32).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId } = await context.params;
    const body = createSchema.parse(await request.json());
    const result = createAgentCredential(sqlite, { userId: session.user.id, agentId, ...body });
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
