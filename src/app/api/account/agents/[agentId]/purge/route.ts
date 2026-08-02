import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import {
  purgeAccountAgent,
  validateAccountAgentPurge,
} from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { createDestructiveOperationBackup } from "@/lib/db/safety-backup";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const purgeSchema = z.object({
  confirmationName: z.string().trim().min(1).max(80),
});

export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { agentId } = await context.params;
    const body = purgeSchema.parse(await request.json());
    validateAccountAgentPurge(sqlite, {
      userId: session.user.id,
      agentId,
      confirmationName: body.confirmationName,
    });
    const backup = await createDestructiveOperationBackup();
    const agent = purgeAccountAgent(sqlite, {
      userId: session.user.id,
      agentId,
      confirmationName: body.confirmationName,
      actorLabel: session.user.name,
      backupGenerationId: backup.manifest.generationId,
    });
    return Response.json({
      agent,
      backupGenerationId: backup.manifest.generationId,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
