import type { DocumentSummary } from "@/lib/documents/types";
import type { WorkspaceSummary } from "@/lib/workspaces/service";
import type { WorkspaceAuditEvent } from "@/lib/authz/audit";
import type { AdminActionRequest } from "@/lib/admin-requests/types";
import type {
  AccountAgentSummary,
  AgentWorkspaceMembershipSummary,
} from "@/lib/agents/service";
import type {
  SiteAdministratorRole,
  SiteAdminView,
} from "@/lib/site-settings/types";
import type { LocalePreference } from "@/lib/i18n/preferences";
import type {
  OrganizationSummary,
  OrganizationView,
} from "@/lib/organizations/service";

export type SettingsView = {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    locale: LocalePreference;
  };
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  organizations: OrganizationSummary[];
  trashedOrganizations: OrganizationSummary[];
  organization: OrganizationView | null;
  organizationAgents: AccountAgentSummary[];
  mcpUrl: string;
  accountAgents: AccountAgentSummary[];
  workspaceAssignableAgents: AccountAgentSummary[];
  workspaceAgentMemberships: AgentWorkspaceMembershipSummary[];
  documents: DocumentSummary[];
  auditEvents: WorkspaceAuditEvent[];
  adminRequests: AdminActionRequest[];
  isSiteAdministrator: boolean;
  siteAdministratorRole: SiteAdministratorRole | null;
  site: SiteAdminView | null;
  permissions: {
    canManageAgents: boolean;
    canManageWorkspace: boolean;
    canTrashWorkspace: boolean;
    canReadAudit: boolean;
    canReviewAdminRequests: boolean;
  };
};
