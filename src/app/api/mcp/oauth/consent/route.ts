import { z } from "zod";
import { agentIdentityIdSchema } from "@/lib/agents/identifiers";
import { auth } from "@/lib/auth";
import { sqlite } from "@/lib/db/client";
import {
  completeMcpOAuthConsent,
  getMcpOAuthAuthorizationRequest,
  getMcpOAuthClient,
  MCP_OAUTH_ACCESS_PROFILES,
} from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const consentFields = {
  consentCode: z.string().trim().min(1).max(4_096),
  workspaceIds: z.array(z.string().uuid()).min(1).max(100),
  accessProfile: z.enum(MCP_OAUTH_ACCESS_PROFILES),
};

const agentSchema = z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("new"),
      displayName: z.string().trim().min(1).max(80),
    }).strict(),
    z.object({
      mode: z.literal("existing"),
      agentId: agentIdentityIdSchema,
    }).strict(),
]);

const consentSchema = z.discriminatedUnion("accept", [
  z.object({
    accept: z.literal(true),
    ...consentFields,
    agent: agentSchema,
  }).strict(),
  z.object({
    accept: z.literal(false),
    ...consentFields,
  }).strict(),
]);

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
    const provisioning = input.accept
      ? {
        userId: session.user.id,
        clientId: client.clientId,
        clientName: client.name,
        requestedScopes: authorization.scopes,
        workspaceIds: input.workspaceIds,
        accessProfile: input.accessProfile,
        agent: input.agent,
      }
      : null;
    const result = await completeMcpOAuthConsent(sqlite, {
      provisioning,
      providerConsent: () => auth.api.oAuthConsent({
        headers: request.headers,
        body: {
          accept: input.accept,
          consent_code: input.consentCode,
        },
      }),
    });
    return Response.json({ redirectURI: result.redirectURI });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "OAuth consent failed." },
      { status: 400 },
    );
  }
}
