export const WORKSPACE_SELECTION_COOKIE = "nyxdoc-workspace";

export function rememberWorkspaceSelection(workspaceId: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${WORKSPACE_SELECTION_COOKIE}=${encodeURIComponent(workspaceId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
