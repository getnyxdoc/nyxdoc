import { z } from "zod";
import { requireVerifiedSession } from "@/data/session";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  createOrganization,
  listUserOrganizations,
} from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().max(16).nullable().optional(),
});

export async function GET() {
  try {
    const session = await requireVerifiedSession();
    return Response.json({
      organizations: listUserOrganizations(sqlite, session.user.id, { includeTrashed: true }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const body = createSchema.parse(await request.json());
    const organization = createOrganization(sqlite, {
      userId: session.user.id,
      actorLabel: session.user.name,
      name: body.name,
      icon: body.icon,
    });
    return Response.json({ organization }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
