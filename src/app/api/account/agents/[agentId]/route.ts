import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { deleteAccountAgent, updateAccountAgent } from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatarMediaId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "변경할 값을 하나 이상 입력해주세요.",
});

export async function PATCH(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId } = await context.params;
    const body = updateSchema.parse(await request.json());
    return Response.json({
      agent: updateAccountAgent(sqlite, { userId: session.user.id, agentId, ...body }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId } = await context.params;
    return Response.json({
      agent: deleteAccountAgent(sqlite, { userId: session.user.id, agentId }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
