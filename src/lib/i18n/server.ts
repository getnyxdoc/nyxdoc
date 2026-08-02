import "server-only";

import { cookies, headers } from "next/headers";
import {
  detectLocale,
  LOCALE_COOKIE,
  normalizeLocale,
} from "@/lib/i18n/locales";
import {
  translate,
  type MessageKey,
  type TranslationValues,
} from "@/lib/i18n/messages";

export async function getRequestLocale() {
  const cookieLocale = normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  if (cookieLocale) return cookieLocale;
  return detectLocale((await headers()).get("accept-language"));
}

export async function getServerI18n() {
  const locale = await getRequestLocale();
  return {
    locale,
    t: (key: MessageKey, values?: TranslationValues) =>
      translate(locale, key, values),
  };
}
