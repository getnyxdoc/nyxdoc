import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SettingsShell, type SettingsArea } from "@/components/settings/settings-shell";
import { getCurrentSession, sessionEmailIsAccepted } from "@/data/session";
import { loadSettingsView } from "@/data/settings";
import { WORKSPACE_SELECTION_COOKIE } from "@/lib/workspaces/selection";
import { buildSettingsHref, normalizeSettingsReturnTo } from "@/lib/settings/navigation";
import { buildAuthPageHref } from "@/components/auth/auth-navigation";

export async function SettingsPageContent({
  area,
  initialConnectAgent = false,
  initialWorkspaceOnboarding = false,
  initialAgentId,
  connectionReturnHref,
  documentSelector,
  workspaceSelector,
  organizationSelector,
}: {
  area: SettingsArea;
  initialConnectAgent?: boolean;
  initialWorkspaceOnboarding?: boolean;
  initialAgentId?: string;
  connectionReturnHref?: string;
  documentSelector?: string;
  workspaceSelector?: string;
  organizationSelector?: string;
}) {
  const resume = new URL(buildSettingsHref({ area, workspaceId: workspaceSelector, documentId: documentSelector, organizationId: organizationSelector, returnTo: connectionReturnHref }), "https://nyxdoc.invalid");
  if (initialConnectAgent) resume.searchParams.set("connectAgent", "1");
  if (initialWorkspaceOnboarding) resume.searchParams.set("workspaceOnboarding", "1");
  if (initialAgentId) resume.searchParams.set("agent", initialAgentId);
  const callbackURL = `${resume.pathname}${resume.search}`;
  const session = await getCurrentSession();
  if (!session) redirect(buildAuthPageHref("/sign-in", { callbackURL }));
  if (!sessionEmailIsAccepted(session)) {
    redirect(buildAuthPageHref("/verify-email", { callbackURL, email: session.user.email }));
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
      redirect(buildSettingsHref({
        area: "organization",
        workspaceId: view.workspace.id,
        documentId: documentSelector,
        organizationId: fallbackOrganization.id,
        returnTo: connectionReturnHref,
      }));
    }
  }
  if (area === "site" && !view.isSiteAdministrator) {
    redirect(buildSettingsHref({ area: "account", workspaceId: view.workspace.id, documentId: documentSelector, returnTo: connectionReturnHref }));
  }
  return <SettingsShell
    key={`${area}:${view.workspace.id}`}
    area={area}
    initialConnectAgent={initialConnectAgent}
    initialWorkspaceOnboarding={initialWorkspaceOnboarding}
    initialAgentId={initialAgentId}
    connectionReturnHref={normalizeSettingsReturnTo(connectionReturnHref)}
    currentDocumentId={documentSelector}
    view={view}
  />;
}
