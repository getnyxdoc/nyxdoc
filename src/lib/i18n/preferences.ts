import type { NyxDatabase } from "@/lib/db/client";
import type { AppLocale } from "@/lib/i18n/locales";

export type LocalePreference = AppLocale | null;

export function getUserLocalePreference(
  database: NyxDatabase,
  userId: string,
): LocalePreference {
  const hasLocale = database.prepare(
    `SELECT 1 FROM pragma_table_info('user') WHERE name = 'locale'`,
  ).get();
  if (!hasLocale) return null;
  const row = database.prepare(
    "SELECT locale FROM user WHERE id = ?",
  ).get(userId) as { locale: LocalePreference } | undefined;
  return row?.locale ?? null;
}

export function setUserLocalePreference(
  database: NyxDatabase,
  userId: string,
  locale: LocalePreference,
) {
  const result = database.prepare(
    `UPDATE user SET locale = ?, updatedAt = ? WHERE id = ?`,
  ).run(locale, new Date().toISOString(), userId);
  if (result.changes !== 1) throw new Error("User not found.");
}
