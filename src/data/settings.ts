import "server-only";

import { sqlite } from "@/lib/db/client";
import { listAdminActionRequests } from "@/lib/admin-requests/service";
import {
  listOrganizationAgents,
  listPersonalAgents,
  listWorkspaceAgentMemberships,
} from "@/lib/agents/service";
import { listWorkspaceAuditEvents } from "@/lib/authz/audit";
import { humanRoleAllows } from "@/lib/authz/permissions";
import { getAuthBaseUrl } from "@/lib/config";
import type { SettingsView } from "@/lib/settings/types";
import { listDocuments } from "@/lib/documents/service";
import {
  listUserMembershipWorkspaces,
  resolveUserWorkspace,
} from "@/lib/workspaces/service";
import {
  ensureSiteAdministratorBootstrap,
  getSiteAdministratorRole,
  loadSiteAdminView,
} from "@/lib/site-settings/service";
import { getUserLocalePreference } from "@/lib/i18n/preferences";
import {
  listUserOrganizations,
  loadOrganizationView,
} from "@/lib/organizations/service";

type SettingsUser = { id: string; name: string; email: string; image: string | null };

export function loadSettingsView(
  user: SettingsUser,
  workspaceSelector?: string,
  fallbackOnMissingWorkspace = false,
  organizationSelector?: string,
): SettingsView {
  ensureSiteAdministratorBootstrap(sqlite, user);
  const siteAdministratorRole = getSiteAdministratorRole(sqlite, user);
  const siteAdministrator = siteAdministratorRole !== null;
  const workspace = resolveUserWorkspace(sqlite, user, {
    selector: workspaceSelector,
    fallbackOnMissingSelector: fallbackOnMissingWorkspace,
    membershipOnly: true,
  });
  const allOrganizations = listUserOrganizations(sqlite, user.id, { includeTrashed: true });
  const organizations = allOrganizations.filter(
    (organization) => organization.lifecycleState === "active",
  );
  const workspaceOwnerOrganization = workspace.owner.type === "organization"
    ? organizations.find((organization) => organization.id === workspace.owner.id) ?? null
    : null;
  const canManageAgents = humanRoleAllows(workspace.role, "credentials.read")
    && (workspace.owner.type === "personal"
      || workspaceOwnerOrganization?.role === "owner"
      || workspaceOwnerOrganization?.role === "admin");
  const canReadAudit = humanRoleAllows(workspace.role, "audit.read");
  const canReviewAdminRequests = humanRoleAllows(workspace.role, "admin_requests.review");
  const personalAgents = listPersonalAgents(sqlite, user.id);
  const workspaceAssignableAgents = canManageAgents
    ? workspace.owner.type === "organization"
      ? [...listOrganizationAgents(sqlite, workspace.owner.id, user.id), ...personalAgents]
      : personalAgents
    : [];
  const selectedOrganization = organizationSelector
    ? organizations.find((organization) => organization.id === organizationSelector) ?? null
    : null;
  const organization = selectedOrganization
    ? loadOrganizationView(sqlite, selectedOrganization.id, user.id)
    : null;
  return {
    user: {
      ...user,
      locale: getUserLocalePreference(sqlite, user.id),
    },
    workspace,
    workspaces: listUserMembershipWorkspaces(sqlite, user.id),
    organizations,
    trashedOrganizations: allOrganizations.filter(
      (organization) => organization.lifecycleState === "trashed",
    ),
    organization,
    organizationAgents: organization
      ? listOrganizationAgents(sqlite, organization.organization.id, user.id)
      : [],
    mcpUrl: `${getAuthBaseUrl().replace(/\/$/, "")}/mcp`,
    accountAgents: personalAgents,
    workspaceAssignableAgents,
    workspaceAgentMemberships: canManageAgents
      ? listWorkspaceAgentMemberships(sqlite, workspace.id, user.id)
      : [],
    documents: listDocuments(sqlite, workspace.id),
    auditEvents: canReadAudit
      ? listWorkspaceAuditEvents(sqlite, workspace.id, { limit: 40 }).events
      : [],
    adminRequests: canReviewAdminRequests
      ? listAdminActionRequests(sqlite, workspace.id, { limit: 40 })
      : [],
    isSiteAdministrator: siteAdministrator,
    siteAdministratorRole,
    site: siteAdministrator ? loadSiteAdminView(sqlite, user) : null,
    permissions: {
      canManageAgents,
      canManageWorkspace: humanRoleAllows(workspace.role, "workspace.update"),
      canTrashWorkspace: workspace.owner.type === "personal"
        ? workspace.owner.id === user.id
        : workspaceOwnerOrganization?.role === "owner"
          || workspaceOwnerOrganization?.role === "admin",
      canReadAudit,
      canReviewAdminRequests,
    },
  };
}
