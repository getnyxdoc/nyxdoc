import { z } from "zod";
import { NextResponse } from "next/server";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireVerifiedSession } from "@/data/session";
import { auth } from "@/lib/auth";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { getMediaAsset } from "@/lib/media/service";
import {
  getUserLocalePreference,
  setUserLocalePreference,
} from "@/lib/i18n/preferences";
import { LOCALE_COOKIE } from "@/lib/i18n/locales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  avatarMediaId: z.string().uuid().nullable().optional(),
  locale: z.enum(["en", "ko", "ja"]).nullable().optional(),
});

function applyLocaleCookie(
  response: NextResponse,
  locale: "en" | "ko" | "ja" | null,
) {
  if (locale) {
    response.cookies.set(LOCALE_COOKIE, locale, {
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  } else {
    response.cookies.delete(LOCALE_COOKIE);
  }
}

export async function GET() {
  try {
    const session = await requireVerifiedSession();
    const locale = getUserLocalePreference(sqlite, session.user.id);
    const response = NextResponse.json({
      profile: {
        image: session.user.image ?? null,
        locale,
        name: session.user.name,
      },
    }, { headers: { "Cache-Control": "no-store" } });
    applyLocaleCookie(response, locale);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = updateProfileSchema.parse(await request.json());

    const avatarUrl = body.avatarMediaId === undefined
      ? session.user.image ?? null
      : body.avatarMediaId === null
        ? null
        : getMediaAsset(sqlite, workspace.id, body.avatarMediaId).url;
    const userUpdate: { image?: string | null; name: string } = { name: body.name };
    if (body.avatarMediaId !== undefined) userUpdate.image = avatarUrl;

    const authUpdate = await auth.api.updateUser({
      body: userUpdate,
      headers: request.headers,
      returnHeaders: true,
    });
    if (body.locale !== undefined) {
      setUserLocalePreference(sqlite, session.user.id, body.locale);
    }
    const locale = body.locale === undefined
      ? getUserLocalePreference(sqlite, session.user.id)
      : body.locale;

    const response = NextResponse.json(
      {
        profile: {
          image: avatarUrl,
          locale,
          name: body.name,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    for (const cookie of authUpdate.headers.getSetCookie()) {
      response.headers.append("Set-Cookie", cookie);
    }
    applyLocaleCookie(response, locale);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
