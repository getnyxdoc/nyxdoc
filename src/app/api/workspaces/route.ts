import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { getRequestLocale } from "@/lib/i18n/server";
import { createWorkspace, listUserWorkspaces } from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  organizationId: z.string().uuid().nullable().optional(),
});

export async function GET() {
  try {
    const session = await requireVerifiedSession();
    return Response.json(
      { workspaces: listUserWorkspaces(sqlite, session.user.id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const body = createWorkspaceSchema.parse(await request.json());
    const workspace = createWorkspace(sqlite, {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }, body.name, await getRequestLocale(), {
      organizationId: body.organizationId,
    });
    return Response.json({ workspace }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
