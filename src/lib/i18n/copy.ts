import type { AppLocale } from "@/lib/i18n/locales";
import type { TranslationValues } from "@/lib/i18n/messages";

type MatchingCopy<T extends Record<string, string>> = {
  [K in keyof T]: string;
};

export function defineUiCopy<const T extends Record<string, string>>(copy: {
  en: T;
  ko: MatchingCopy<T>;
  ja: MatchingCopy<T>;
}) {
  return copy;
}

export function formatCopy(
  message: string,
  values: TranslationValues = {},
) {
  let output = message;
  for (const [name, value] of Object.entries(values)) {
    output = output.replaceAll(`{${name}}`, String(value));
  }
  return output;
}

export function pickCopy<
  const T extends Record<string, string>,
  K extends keyof T,
>(
  copy: { en: T; ko: MatchingCopy<T>; ja: MatchingCopy<T> },
  locale: AppLocale,
  key: K,
  values: TranslationValues = {},
) {
  return formatCopy(copy[locale][key], values);
}
