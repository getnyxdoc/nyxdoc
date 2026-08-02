export const SUPPORTED_LOCALES = ["en", "ko", "ja"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";
export const LOCALE_COOKIE = "nyxdoc_locale";

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  const normalized = value?.trim().toLowerCase().replace("_", "-");
  if (!normalized) return null;
  const language = normalized.split("-")[0];
  return SUPPORTED_LOCALES.includes(language as AppLocale)
    ? language as AppLocale
    : null;
}

export function detectLocale(acceptLanguage: string | null | undefined): AppLocale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const candidates = acceptLanguage
    .split(",")
    .map((item) => {
      const [tag, ...parameters] = item.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      return {
        locale: normalizeLocale(tag),
        quality: quality ? Number(quality.slice(2)) : 1,
      };
    })
    .filter((candidate): candidate is { locale: AppLocale; quality: number } =>
      Boolean(candidate.locale) && Number.isFinite(candidate.quality))
    .sort((left, right) => right.quality - left.quality);
  return candidates[0]?.locale ?? DEFAULT_LOCALE;
}

export function localeLabel(locale: AppLocale) {
  return {
    en: "English",
    ko: "한국어",
    ja: "日本語",
  }[locale];
}

export function localeTag(locale: AppLocale) {
  return {
    en: "en-US",
    ko: "ko-KR",
    ja: "ja-JP",
  }[locale];
}
