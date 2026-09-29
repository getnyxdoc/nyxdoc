import { redirect } from "next/navigation";
import { buildSettingsHref } from "@/lib/settings/navigation";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string; workspace?: string; returnTo?: string }>;
}) {
  const { document, workspace, returnTo } = await searchParams;
  redirect(buildSettingsHref({ area: "account", workspaceId: workspace, documentId: document, returnTo }));
}
