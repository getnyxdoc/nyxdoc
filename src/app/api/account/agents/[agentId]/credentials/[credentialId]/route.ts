import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { revokeAgentCredential, updateAgentCredential } from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { API_TOKEN_SCOPES } from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(API_TOKEN_SCOPES.length),
  defaultWorkspaceId: z.string().uuid().nullable(),
  workspaceIds: z.array(z.string().uuid()).max(100),
  ipAllowlist: z.array(z.string().max(80)).max(32),
  expiresAt: z.string().datetime().nullable(),
}).strict();

export async function PATCH(request: Request, context: { params: Promise<{ agentId: string; credentialId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId, credentialId } = await context.params;
    const body = updateSchema.parse(await request.json());
    return Response.json({
      credential: updateAgentCredential(sqlite, {
        userId: session.user.id,
        agentId,
        credentialId,
        ...body,
        workspaceAllowlist: body.workspaceIds,
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ agentId: string; credentialId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId, credentialId } = await context.params;
    revokeAgentCredential(sqlite, { userId: session.user.id, agentId, credentialId });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
