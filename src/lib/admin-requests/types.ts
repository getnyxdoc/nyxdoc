import type { ApiTokenSummary } from "@/lib/tokens/service";
import type { AdminActionProposal } from "@/lib/admin-requests/schemas";

export type AdminActionStatus = "pending" | "executed" | "rejected" | "failed" | "expired";

export type AdminActionRequest = {
  id: string;
  requestId: string;
  workspaceId: string;
  actionType: AdminActionProposal["actionType"];
  status: AdminActionStatus;
  reason: string;
  payload: Record<string, unknown>;
  preview: string;
  requestedByAgentId: string | null;
  requestedByLabel: string;
  requestedAt: string;
  expiresAt: string;
  reviewedByUserId: string | null;
  reviewedByLabel: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  executionResult: Record<string, unknown> | null;
};

export type AdminActionReviewResult = {
  request: AdminActionRequest;
  revealedToken?: string;
  tokenSummary?: ApiTokenSummary;
};

export class AdminActionRequestError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "CONFLICT"
      | "EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "AdminActionRequestError";
  }
}
