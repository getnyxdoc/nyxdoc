import { NextResponse } from "next/server";
import { AppAuthError } from "@/data/session";
import { AgentServiceError } from "@/lib/agents/service";
import { AdminActionRequestError } from "@/lib/admin-requests/types";
import { AuthorizationError } from "@/lib/authz/permissions";
import { PresenceError } from "@/lib/collaboration/presence";
import { DocumentServiceError } from "@/lib/documents/types";
import { OriginError } from "@/lib/http/origin";
import { MediaServiceError } from "@/lib/media/service";
import { OrganizationServiceError } from "@/lib/organizations/service";
import { SettingsServiceError } from "@/lib/settings/service";
import { TaskServiceError } from "@/lib/tasks/types";
import { ApiTokenError } from "@/lib/tokens/service";
import { WorkspaceServiceError } from "@/lib/workspaces/service";
import { PublicShareError } from "@/lib/sharing/service";
import { SiteSettingsError } from "@/lib/site-settings/types";
import { getRequestLocale } from "@/lib/i18n/server";
import { translate, type MessageKey } from "@/lib/i18n/messages";

function messageKeyForCode(code: string): MessageKey {
  if (code === "UNAUTHORIZED" || code === "UNAUTHENTICATED") {
    return "api.authenticationRequired";
  }
  if (code === "FORBIDDEN") return "api.forbidden";
  if (code === "NOT_FOUND") return "api.notFound";
  if (code === "EXPIRED") return "api.expired";
  if (code === "TOO_LARGE") return "api.tooLarge";
  if (code === "UNSUPPORTED_TYPE") return "api.unsupportedType";
  if (code === "COLLABORATION_UNAVAILABLE") return "api.collaborationUnavailable";
  if (
    code === "CONFLICT"
    || code === "DRAFT_CONFLICT"
    || code === "DRAFT_NOT_SYNCED"
    || code === "DRAFT_VERSION_CONFLICT"
    || code === "IDEMPOTENCY_CONFLICT"
    || code === "REVISION_CONFLICT"
  ) return "api.conflict";
  return "api.invalidInput";
}

export async function apiErrorResponse(error: unknown) {
  const locale = await getRequestLocale();
  const response = (
    code: string,
    status: number,
    details?: unknown,
    messageKey = messageKeyForCode(code),
    publicMessage?: string,
  ) => NextResponse.json(
    {
      error: publicMessage ?? translate(locale, messageKey),
      code,
      ...(details ? { details } : {}),
    },
    { status },
  );

  if (error instanceof AppAuthError) {
    return response(error.code, 401, undefined, "api.authenticationRequired");
  }
  if (error instanceof OriginError) {
    return response("INVALID_ORIGIN", 403, undefined, "api.invalidOrigin");
  }
  if (error instanceof AgentServiceError) {
    const status = error.code === "FORBIDDEN"
      ? 403
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "CONFLICT" || error.code === "GRANT_ALREADY_ACTIVE"
          ? 409
          : 400;
    return response(error.code, status, error.details, messageKeyForCode(error.code), error.message);
  }
  if (error instanceof AuthorizationError) {
    return response(error.code, error.code === "FORBIDDEN" ? 403 : 404);
  }
  if (error instanceof AdminActionRequestError) {
    const status = error.code === "NOT_FOUND"
      ? 404
      : error.code === "CONFLICT" || error.code === "EXPIRED"
        ? 409
        : 400;
    return response(error.code, status);
  }
  if (error instanceof PresenceError) {
    return response("FORBIDDEN", 403);
  }
  if (error instanceof WorkspaceServiceError) {
    const status = error.code === "FORBIDDEN"
      ? 403
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "CONFLICT"
          ? 409
          : 400;
    return response(error.code, status);
  }
  if (error instanceof OrganizationServiceError) {
    const status = error.code === "FORBIDDEN"
      ? 403
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "CONFLICT"
          ? 409
          : 400;
    return response(error.code, status);
  }
  if (error instanceof MediaServiceError) {
    const status =
      error.code === "UNAUTHORIZED"
        ? 401
        : error.code === "NOT_FOUND"
        ? 404
        : error.code === "EXPIRED"
          ? 410
          : error.code === "CONFLICT"
            ? 409
        : error.code === "TOO_LARGE"
          ? 413
          : error.code === "UNSUPPORTED_TYPE"
            ? 415
            : 400;
    return response(error.code, status);
  }
  if (error instanceof PublicShareError) {
    return response(error.code, error.code === "NOT_FOUND" ? 404 : 400);
  }
  if (error instanceof SettingsServiceError) {
    return response(error.code, error.code === "FORBIDDEN" ? 403 : 404);
  }
  if (error instanceof SiteSettingsError) {
    const status = error.code === "FORBIDDEN"
      ? 403
      : error.code === "CONFLICT"
        ? 409
        : 400;
    return response(error.code, status, error.details);
  }
  if (error instanceof TaskServiceError) {
    const status = error.code === "FORBIDDEN"
      ? 403
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT"
          ? 409
          : 400;
    return response(error.code, status, error.details);
  }
  if (error instanceof DocumentServiceError) {
    const status =
      error.code === "FORBIDDEN"
        ? 403
        : error.code === "COLLABORATION_UNAVAILABLE"
          ? 503
        : error.code === "NOT_FOUND"
          ? 404
          : error.code === "REVISION_CONFLICT"
              || error.code === "DRAFT_CONFLICT"
              || error.code === "DRAFT_NOT_SYNCED"
              || error.code === "DRAFT_VERSION_CONFLICT"
              || error.code === "IDEMPOTENCY_CONFLICT"
            ? 409
            : 400;
    return response(error.code, status, error.details);
  }
  if (error instanceof ApiTokenError) {
    const status =
      error.code === "UNAUTHORIZED"
        ? 401
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "NOT_FOUND"
            ? 404
            : 400;
    return response(error.code, status);
  }
  if (error instanceof Error && error.name === "ZodError") {
    const issues = "issues" in error && Array.isArray(error.issues)
      ? error.issues.map((issue: { path?: unknown; message?: unknown; code?: unknown }) => ({
          path: Array.isArray(issue.path) ? issue.path : [],
          message: typeof issue.message === "string" ? issue.message : "Invalid value",
          code: typeof issue.code === "string" ? issue.code : "invalid_input",
        }))
      : [];
    return response("INVALID_INPUT", 400, { issues });
  }
  console.error("[nyxdoc] unhandled API error", error);
  return response("INTERNAL_ERROR", 500, undefined, "api.internalError");
}
