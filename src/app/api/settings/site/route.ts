import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { updateSiteSettingsSchema } from "@/lib/site-settings/schemas";
import {
  loadSiteAdminView,
  updateSiteSettings,
} from "@/lib/site-settings/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireVerifiedSession();
    return Response.json({
      site: loadSiteAdminView(sqlite, {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const body = updateSiteSettingsSchema.parse(await request.json());
    updateSiteSettings(
      sqlite,
      {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
      body,
    );
    return Response.json({
      site: loadSiteAdminView(sqlite, {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
