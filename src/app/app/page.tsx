import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { getCurrentSession, sessionEmailIsAccepted } from "@/data/session";
import { loadWorkspaceView } from "@/data/workspace";
import { getServerI18n } from "@/lib/i18n/server";
import { WORKSPACE_SELECTION_COOKIE } from "@/lib/workspaces/selection";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t("meta.workspace") };
}
export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string; workspace?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/sign-in");
  if (!sessionEmailIsAccepted(session)) {
    redirect(`/verify-email?email=${encodeURIComponent(session.user.email)}`);
  }

  const { document, workspace } = await searchParams;
  const { locale } = await getServerI18n();
  const rememberedWorkspace = (await cookies()).get(WORKSPACE_SELECTION_COOKIE)?.value;
  // A document link is authoritative across workspace moves. The remembered
  // workspace is only a fallback when the URL does not identify a document.
  const workspaceSelector = workspace || (document ? undefined : rememberedWorkspace);
  const view = loadWorkspaceView(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    },
    document,
    workspaceSelector,
    !workspace && !document && Boolean(rememberedWorkspace),
    locale,
  );
  return (
    <WorkspaceShell
      key={`${view.activeDocument.id}:${view.collaboration.generation}`}
      view={view}
    />
  );
}
