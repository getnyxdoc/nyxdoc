import { z } from "zod";
import { auth } from "@/lib/auth";
import { sqlite } from "@/lib/db/client";
import {
  getMcpOAuthAuthorizationRequest,
  getMcpOAuthClient,
  provisionMcpOAuthGrant,
} from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const consentSchema = z.object({
  accept: z.boolean(),
  consentCode: z.string().trim().min(1).max(4_096),
  workspaceIds: z.array(z.string().uuid()).max(100),
  role: z.enum(["admin", "editor", "viewer"]),
  agent: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("new"),
      displayName: z.string().trim().min(1).max(80),
    }).strict(),
    z.object({
      mode: z.literal("existing"),
      agentId: z.string().uuid(),
    }).strict(),
  ]).optional(),
}).strict();

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in is required." }, { status: 401 });
  }
  const parsed = consentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "The OAuth consent request is invalid." }, { status: 400 });
  }
  const input = parsed.data;
  const authorization = getMcpOAuthAuthorizationRequest(
    sqlite,
    input.consentCode,
    session.user.id,
  );
  if (!authorization) {
    return Response.json({ error: "The OAuth consent request is invalid or expired." }, { status: 400 });
  }
  const client = getMcpOAuthClient(sqlite, authorization.clientId);
  if (!client) {
    return Response.json({ error: "The OAuth client was not found." }, { status: 404 });
  }

  try {
    if (input.accept) {
      if (!input.agent) {
        return Response.json(
          { error: "Select the agent identity for this OAuth connection." },
          { status: 400 },
        );
      }
      provisionMcpOAuthGrant(sqlite, {
        userId: session.user.id,
        clientId: client.clientId,
        clientName: client.name,
        requestedScopes: authorization.scopes,
        workspaceIds: input.workspaceIds,
        role: input.role,
        agent: input.agent,
      });
    }
    const result = await auth.api.oAuthConsent({
      headers: request.headers,
      body: {
        accept: input.accept,
        consent_code: input.consentCode,
      },
    });
    return Response.json({ redirectURI: result.redirectURI });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "OAuth consent failed." },
      { status: 400 },
    );
  }
}
