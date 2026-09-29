export type SettingsArea = "account" | "agents" | "organization" | "workspace" | "site";

const RETURN_PATHS = new Set([
  "/app",
  "/settings",
  "/settings/account",
  "/settings/agents",
  "/settings/organization",
  "/settings/workspace",
  "/settings/site",
]);

/** Only allow destinations within the document and settings flows. */
export function normalizeSettingsReturnTo(value?: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value, "https://nyxdoc.invalid");
    if (url.origin !== "https://nyxdoc.invalid" || !RETURN_PATHS.has(url.pathname)) return undefined;
    // Returning must never restart onboarding or another connection wizard.
    url.searchParams.delete("connectAgent");
    url.searchParams.delete("workspaceOnboarding");
    url.searchParams.delete("returnTo");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export function buildAppReturnHref(workspaceId: string, documentId?: string) {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (documentId) query.set("document", documentId);
  return `/app?${query.toString()}`;
}

export function buildSettingsHref({
  area,
  workspaceId,
  documentId,
  organizationId,
  returnTo,
  anchor,
}: {
  area: SettingsArea;
  workspaceId?: string;
  documentId?: string;
  organizationId?: string;
  returnTo?: string;
  anchor?: string;
}) {
  const query = new URLSearchParams();
  if (workspaceId) query.set("workspace", workspaceId);
  if (documentId) query.set("document", documentId);
  if (area === "organization" && organizationId) query.set("organization", organizationId);
  const destination = normalizeSettingsReturnTo(returnTo);
  if (destination) query.set("returnTo", destination);
  return `/settings/${area}${query.size ? `?${query.toString()}` : ""}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

export function buildAgentConnectionHref({
  workspaceId,
  agentId,
  documentId,
  returnTo,
}: {
  workspaceId: string;
  agentId?: string;
  documentId?: string;
  returnTo?: string;
}) {
  const query = new URLSearchParams({ workspace: workspaceId, connectAgent: "1" });
  if (agentId) query.set("agent", agentId);
  if (documentId) query.set("document", documentId);
  const destination = normalizeSettingsReturnTo(returnTo);
  if (destination) query.set("returnTo", destination);
  return `/settings/agents?${query.toString()}#workspace-agents`;
}
