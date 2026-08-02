import type { Metadata } from "next";
import { SettingsPageContent } from "@/app/settings/settings-page-content";
import { getServerI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.agents") };
}
export const dynamic = "force-dynamic";

export default async function AgentSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string; workspace?: string }>;
}) {
  const { document, workspace } = await searchParams;
  return <SettingsPageContent area="agents" documentSelector={document} workspaceSelector={workspace} />;
}
