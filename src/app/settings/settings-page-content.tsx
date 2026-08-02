import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SettingsShell, type SettingsArea } from "@/components/settings/settings-shell";
import { getCurrentSession, sessionEmailIsAccepted } from "@/data/session";
import { loadSettingsView } from "@/data/settings";
import { WORKSPACE_SELECTION_COOKIE } from "@/lib/workspaces/selection";

export async function SettingsPageContent({
  area,
  initialConnectAgent = false,
  initialWorkspaceOnboarding = false,
  documentSelector,
  workspaceSelector,
  organizationSelector,
}: {
  area: SettingsArea;
  initialConnectAgent?: boolean;
  initialWorkspaceOnboarding?: boolean;
  documentSelector?: string;
  workspaceSelector?: string;
  organizationSelector?: string;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/sign-in");
  if (!sessionEmailIsAccepted(session)) {
    redirect(`/verify-email?email=${encodeURIComponent(session.user.email)}`);
  }
  const rememberedWorkspace = (await cookies()).get(WORKSPACE_SELECTION_COOKIE)?.value;
  const view = loadSettingsView(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    },
    workspaceSelector || rememberedWorkspace,
    !workspaceSelector && Boolean(rememberedWorkspace),
    organizationSelector,
  );
  if (area === "organization" && !view.organization) {
    const fallbackOrganization = view.organizations[0];
    if (fallbackOrganization) {
      redirect(
        `/settings/organization?workspace=${encodeURIComponent(view.workspace.id)}`
        + `&organization=${encodeURIComponent(fallbackOrganization.id)}`,
      );
    }
  }
  if (area === "site" && !view.isSiteAdministrator) {
    redirect(`/settings/account?workspace=${encodeURIComponent(view.workspace.id)}`);
  }
  return <SettingsShell
    key={`${area}:${view.workspace.id}`}
    area={area}
    initialConnectAgent={initialConnectAgent}
    initialWorkspaceOnboarding={initialWorkspaceOnboarding}
    currentDocumentId={documentSelector}
    view={view}
  />;
}
