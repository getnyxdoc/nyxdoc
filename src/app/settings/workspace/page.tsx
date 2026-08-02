import type { Metadata } from "next";
import { SettingsPageContent } from "@/app/settings/settings-page-content";
import { getServerI18n } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.workspaceSettings") };
}
export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    workspace?: string;
    document?: string;
    connectAgent?: string;
    workspaceOnboarding?: string;
  }>;
}) {
  const { connectAgent, document, workspace, workspaceOnboarding } = await searchParams;
  return <SettingsPageContent
    area="workspace"
    documentSelector={document}
    initialConnectAgent={connectAgent === "1"}
    initialWorkspaceOnboarding={workspaceOnboarding === "1"}
    workspaceSelector={workspace}
  />;
}
