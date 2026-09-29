const AUTH_CALLBACK_BASE = "https://nyxdoc.invalid";

/** Auth callbacks stay on this site, including OAuth and invitation resumes. */
export function normalizeAuthCallbackURL(value?: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return "/app";
  }
  try {
    const url = new URL(value, AUTH_CALLBACK_BASE);
    const decodedPath = decodeURIComponent(url.pathname);
    if (url.origin !== AUTH_CALLBACK_BASE || decodedPath.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decodedPath)) {
      return "/app";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/app";
  }
}

export function buildAuthPageHref(
  path: "/sign-in" | "/sign-up" | "/verify-email",
  { callbackURL, email }: { callbackURL?: unknown; email?: string } = {},
) {
  const query = new URLSearchParams();
  if (email) query.set("email", email);
  const destination = normalizeAuthCallbackURL(callbackURL);
  if (destination !== "/app") query.set("callbackURL", destination);
  return `${path}${query.size ? `?${query.toString()}` : ""}`;
}
