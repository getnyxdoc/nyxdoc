import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { createDestructiveOperationBackup } from "@/lib/db/safety-backup";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { removeMediaStorageKeys } from "@/lib/media/service";
import {
  purgeWorkspace,
  validateWorkspacePurge,
} from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const purgeSchema = z.object({
  confirmationName: z.string().trim().min(1).max(120),
});

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { workspaceId } = await context.params;
    const body = purgeSchema.parse(await request.json());
    validateWorkspacePurge(sqlite, {
      workspaceId,
      userId: session.user.id,
      confirmationName: body.confirmationName,
    });
    const backup = await createDestructiveOperationBackup();
    const workspace = purgeWorkspace(sqlite, {
      workspaceId,
      userId: session.user.id,
      actorLabel: session.user.name,
      confirmationName: body.confirmationName,
      backupGenerationId: backup.manifest.generationId,
    });
    const cleanup = await removeMediaStorageKeys(workspace.mediaStorageKeys);
    if (cleanup.failed.length > 0) {
      console.error("[nyxdoc] workspace media cleanup incomplete", {
        workspaceId,
        failed: cleanup.failed,
      });
    }
    return Response.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        lifecycleState: workspace.lifecycleState,
        purgedAt: workspace.purgedAt,
        counts: workspace.counts,
      },
      backupGenerationId: workspace.backupGenerationId,
      mediaCleanupPending: cleanup.failed.length,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
