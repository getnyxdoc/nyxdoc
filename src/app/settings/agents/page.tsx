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
  searchParams: Promise<{ document?: string; workspace?: string; returnTo?: string; agent?: string; connectAgent?: string; workspaceOnboarding?: string }>;
}) {
  const { document, workspace, returnTo, agent, connectAgent, workspaceOnboarding } = await searchParams;
  return <SettingsPageContent area="agents" initialConnectAgent={connectAgent === "1"} initialAgentId={agent} initialWorkspaceOnboarding={workspaceOnboarding === "1"} documentSelector={document} workspaceSelector={workspace} connectionReturnHref={returnTo} />;
}
