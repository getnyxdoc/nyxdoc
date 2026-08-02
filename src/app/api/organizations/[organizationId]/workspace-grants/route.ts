import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  removeOrganizationWorkspaceMemberGrant,
  removeOrganizationWorkspaceTeamGrant,
  upsertOrganizationWorkspaceMemberGrant,
  upsertOrganizationWorkspaceTeamGrant,
} from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ organizationId: z.string().uuid() });
const grantSchema = z.discriminatedUnion("principalType", [
  z.object({
    principalType: z.literal("member"),
    principalId: z.string().min(1).max(200),
    workspaceId: z.string().uuid(),
    role: z.enum(["admin", "editor", "viewer"]),
  }),
  z.object({
    principalType: z.literal("team"),
    principalId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    role: z.enum(["admin", "editor", "viewer"]),
  }),
]);
const removeSchema = z.discriminatedUnion("principalType", [
  z.object({
    principalType: z.literal("member"),
    principalId: z.string().min(1).max(200),
    workspaceId: z.string().uuid(),
  }),
  z.object({
    principalType: z.literal("team"),
    principalId: z.string().uuid(),
    workspaceId: z.string().uuid(),
  }),
]);

export async function PUT(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    const body = grantSchema.parse(await request.json());
    if (body.principalType === "team") {
      return Response.json({
        grant: upsertOrganizationWorkspaceTeamGrant(sqlite, {
          organizationId,
          userId: session.user.id,
          actorLabel: session.user.name,
          workspaceId: body.workspaceId,
          teamId: body.principalId,
          role: body.role,
        }),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    upsertOrganizationWorkspaceMemberGrant(sqlite, {
      organizationId,
      userId: session.user.id,
      actorLabel: session.user.name,
      workspaceId: body.workspaceId,
      targetUserId: body.principalId,
      role: body.role,
    });
    return Response.json({ updated: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { organizationId } = paramsSchema.parse(await context.params);
    const body = removeSchema.parse(await request.json());
    if (body.principalType === "team") {
      removeOrganizationWorkspaceTeamGrant(sqlite, {
        organizationId,
        userId: session.user.id,
        actorLabel: session.user.name,
        workspaceId: body.workspaceId,
        teamId: body.principalId,
      });
    } else {
      removeOrganizationWorkspaceMemberGrant(sqlite, {
        organizationId,
        userId: session.user.id,
        actorLabel: session.user.name,
        workspaceId: body.workspaceId,
        targetUserId: body.principalId,
      });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
