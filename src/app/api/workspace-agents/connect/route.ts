import { z } from "zod";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { connectAgentToWorkspace } from "@/lib/agents/service";
import { AGENT_ACCESS_PROFILES, WORKSPACE_PERMISSIONS } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const connectSchema = z.object({
  agent: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      agentId: z.string().uuid(),
    }),
    z.object({
      mode: z.literal("new"),
      displayName: z.string().trim().min(1).max(80),
    }),
  ]),
  accessProfile: z.enum(AGENT_ACCESS_PROFILES),
  capabilities: z.array(z.enum(WORKSPACE_PERMISSIONS)).max(WORKSPACE_PERMISSIONS.length).optional(),
  rootDocumentId: z.string().uuid().nullable(),
  credential: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      credentialId: z.string().uuid(),
    }),
    z.object({
      mode: z.literal("new"),
      name: z.string().trim().min(1).max(80),
      restrictToWorkspace: z.boolean(),
    }),
    z.object({ mode: z.literal("later") }),
  ]),
}).strict().superRefine((value, context) => {
  if (value.accessProfile === "custom" && !value.capabilities?.length) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "A custom access profile requires at least one capability.",
    });
  }
  if (value.accessProfile !== "custom" && value.capabilities !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "Fixed access profiles define their own capabilities.",
    });
  }
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = connectSchema.parse(await request.json());
    return Response.json(
      connectAgentToWorkspace(sqlite, {
        userId: session.user.id,
        workspaceId: workspace.id,
        ...body,
      }),
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
