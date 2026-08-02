import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { I18nProvider } from "@/lib/i18n/client";
import { getRequestLocale, getServerI18n } from "@/lib/i18n/server";
import { getAuthBaseUrl } from "@/lib/config";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  const description = t("meta.description");
  return {
    metadataBase: new URL(getAuthBaseUrl()),
    applicationName: "Nyxdoc",
    title: { default: "Nyxdoc", template: "%s · Nyxdoc" },
    description,
    manifest: "/site.webmanifest",
    icons: {
      icon: [
        { url: "/nyxdoc-mark.svg", type: "image/svg+xml" },
        { url: "/nyxdoc-icon-32.png", sizes: "32x32", type: "image/png" },
      ],
      shortcut: "/favicon.ico",
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    openGraph: {
      title: "Nyxdoc",
      description,
      url: "/",
      siteName: "Nyxdoc",
      type: "website",
      images: [
        {
          url: "/og.png",
          width: 1200,
          height: 630,
          alt: t("meta.ogAlt"),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Nyxdoc",
      description,
      images: ["/og.png"],
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getRequestLocale();
  return (
    <html lang={locale} className={`${geistSans.variable} ${geistMono.variable}`}>
      <body><I18nProvider locale={locale}>{children}</I18nProvider></body>
    </html>
  );
}
