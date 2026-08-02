import { redirect } from "next/navigation";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string; workspace?: string }>;
}) {
  const { document, workspace } = await searchParams;
  const query = new URLSearchParams();
  if (workspace) query.set("workspace", workspace);
  if (document) query.set("document", document);
  redirect(query.size > 0
    ? `/settings/account?${query.toString()}`
    : "/settings/account");
}
