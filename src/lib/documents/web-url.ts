import { getAuthBaseUrl } from "@/lib/config";

export function getDocumentWebUrl(
  workspaceId: string,
  documentId: string,
  baseUrl = getAuthBaseUrl(),
) {
  const url = new URL("/app", baseUrl);
  url.searchParams.set("workspace", workspaceId);
  url.searchParams.set("document", documentId);
  return url.toString();
}
