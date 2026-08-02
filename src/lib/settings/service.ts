import type { NyxDatabase } from "@/lib/db/client";
import {
  AuthorizationError,
  recordWorkspaceAuditEvent,
  requireHumanWorkspacePermission,
} from "@/lib/authz/permissions";

export class SettingsServiceError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SettingsServiceError";
  }
}

export function assertWorkspaceOwner(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
) {
  try {
    requireHumanWorkspacePermission(database, workspaceId, userId, "workspace.update");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new SettingsServiceError(error.code, error.message);
    }
    throw error;
  }
}

export function updateWorkspaceName(
  database: NyxDatabase,
  workspaceId: string,
  userId: string,
  name: string,
) {
  assertWorkspaceOwner(database, workspaceId, userId);
  const updatedAt = new Date().toISOString();
  const result = database
    .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, updatedAt, workspaceId);
  if (result.changes !== 1) {
    throw new SettingsServiceError("NOT_FOUND", "워크스페이스를 찾을 수 없습니다.");
  }
  recordWorkspaceAuditEvent(database, {
    workspaceId,
    action: "workspace.renamed",
    actorType: "human",
    actorUserId: userId,
    actorLabel: "사용자",
    targetType: "workspace",
    targetId: workspaceId,
    metadata: { name },
    createdAt: updatedAt,
  });
  return { id: workspaceId, name, updatedAt };
}
