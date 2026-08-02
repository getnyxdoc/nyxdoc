import type { Metadata } from "next";
import { SettingsPageContent } from "@/app/settings/settings-page-content";
import { getServerI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("settings.site.title") };
}
export const dynamic = "force-dynamic";

export default async function SiteSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string; workspace?: string }>;
}) {
  const { document, workspace } = await searchParams;
  return (
    <SettingsPageContent
      area="site"
      documentSelector={document}
      workspaceSelector={workspace}
    />
  );
}
