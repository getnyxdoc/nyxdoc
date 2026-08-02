import type { Metadata } from "next";
import { SettingsPageContent } from "@/app/settings/settings-page-content";

export const metadata: Metadata = { title: "조직 설정 · Nyxdoc" };
export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    organization?: string;
    workspace?: string;
    document?: string;
  }>;
}) {
  const { document, organization, workspace } = await searchParams;
  return <SettingsPageContent
    area="organization"
    documentSelector={document}
    organizationSelector={organization}
    workspaceSelector={workspace}
  />;
}
