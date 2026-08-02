"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { AppLocale } from "@/lib/i18n/locales";
import {
  translate,
  type MessageKey,
  type TranslationValues,
} from "@/lib/i18n/messages";

type I18nContextValue = {
  locale: AppLocale;
  t: (key: MessageKey, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  locale,
}: {
  children: ReactNode;
  locale: AppLocale;
}) {
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    t: (key, values) => translate(locale, key, values),
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider.");
  return value;
}
