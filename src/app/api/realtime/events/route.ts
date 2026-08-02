import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  requireHumanDocumentPermission,
  requireHumanWorkspacePermission,
} from "@/lib/authz/permissions";
import { listWorkspacePresence, presenceVersion } from "@/lib/collaboration/presence";
import { sqlite } from "@/lib/db/client";
import { getChanges } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { getServerI18n } from "@/lib/i18n/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { t } = await getServerI18n();
    const url = new URL(request.url);
    const { session, workspace } = await requireWorkspaceSession(
      request,
      url.searchParams.get("workspace") ?? undefined,
    );
    const documentId = url.searchParams.get("document");
    if (documentId) {
      requireHumanDocumentPermission(
        sqlite,
        workspace.id,
        documentId,
        session.user.id,
        "changes.read",
      );
    } else {
      requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "changes.read");
    }
    const requestedCursor = url.searchParams.get("since");
    const head = getChanges(sqlite, workspace.id, 0, 1).headCursor;
    let cursor = requestedCursor === null ? head : Number(requestedCursor);
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new DocumentServiceError("INVALID_INPUT", "since 커서를 확인해주세요.");
    }
    cursor = Math.min(cursor, head);

    const encoder = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let latestPresenceVersion = -1;
        let heartbeatCounter = 0;

        const send = (event: string, value: unknown, id?: number) => {
          if (closed) return;
          const idLine = id === undefined ? "" : `id: ${id}\n`;
          controller.enqueue(encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          request.signal.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            // The browser may already have closed the stream.
          }
        };
        const tick = () => {
          if (closed) return;
          try {
            const version = presenceVersion();
            if (version !== latestPresenceVersion) {
              latestPresenceVersion = version;
              send("presence", {
                presence: listWorkspacePresence(workspace.id)
                  .filter((entry) => !documentId || entry.documentId === documentId),
                ttlSeconds: 45,
              });
            }
            const changes = getChanges(sqlite, workspace.id, cursor, 100);
            for (const event of changes.events) {
              cursor = event.cursor;
              if (documentId && event.documentId !== documentId) continue;
              send("document-change", event, event.cursor);
            }
            heartbeatCounter += 1;
            if (heartbeatCounter >= 15) {
              heartbeatCounter = 0;
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
            }
          } catch (error) {
            console.error("[nyxdoc] realtime stream tick failed", error);
            send("stream-error", { error: t("api.internalError") });
            close();
          }
        };

        const timer = setInterval(tick, 1_000);
        stop = close;
        request.signal.addEventListener("abort", close, { once: true });
        send("ready", { cursor, workspaceId: workspace.id, documentId });
        tick();
      },
      cancel() {
        stop();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
