import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { agentIdentityIdSchema } from "@/lib/agents/identifiers";
import {
  purgeAccountAgent,
  validateAccountAgentPurge,
} from "@/lib/agents/service";
import { sqlite } from "@/lib/db/client";
import { withDestructiveOperationBackup } from "@/lib/db/safety-backup";
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
    const { agentId: rawAgentId } = await context.params;
    const agentId = agentIdentityIdSchema.parse(rawAgentId);
    const body = purgeSchema.parse(await request.json());
    validateAccountAgentPurge(sqlite, {
      userId: session.user.id,
      agentId,
      confirmationName: body.confirmationName,
    });
    const protectedOperation = await withDestructiveOperationBackup((backup) =>
      purgeAccountAgent(sqlite, {
        userId: session.user.id,
        agentId,
        confirmationName: body.confirmationName,
        actorLabel: session.user.name,
        backupGenerationId: backup.manifest.generationId,
      }));
    const agent = protectedOperation.result;
    if (protectedOperation.warnings.length > 0) {
      console.warn("[nyxdoc] agent purge completed with backup barrier warnings", {
        agentId,
        warnings: protectedOperation.warnings,
      });
    }
    return Response.json({
      agent,
      backupGenerationId: protectedOperation.backup.manifest.generationId,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
