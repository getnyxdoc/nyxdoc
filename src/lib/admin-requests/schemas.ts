import { z } from "zod";
import { workspaceAgentIdSchema } from "@/lib/collaboration/schemas";
import { API_TOKEN_SCOPES } from "@/lib/tokens/service";

const nonEmptyChange = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "변경할 값을 하나 이상 입력해주세요.",
  });

export const workspaceCreatePayloadSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export const workspaceUpdatePayloadSchema = nonEmptyChange({
  name: z.string().trim().min(1).max(120).optional(),
  trashRetentionDays: z.number().int().min(1).max(3650).optional(),
  trashAutoPurge: z.boolean().optional(),
});

export const agentConnectPayloadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(["admin", "editor", "viewer"]),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(API_TOKEN_SCOPES.length),
  rootDocumentId: z.string().uuid().nullable().optional(),
}).strict();

export const agentUpdatePayloadSchema = z.object({
  agentId: workspaceAgentIdSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "editor", "viewer"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().refine((value) => (
  value.displayName !== undefined || value.role !== undefined || value.status !== undefined
), {
  message: "변경할 에이전트 정보를 하나 이상 입력해주세요.",
});

export const credentialRotatePayloadSchema = z.object({
  agentId: workspaceAgentIdSchema,
}).strict();

export const credentialRevokePayloadSchema = z.object({
  credentialId: z.string().uuid(),
}).strict();

export const adminActionProposalSchema = z.discriminatedUnion("actionType", [
  z.object({ actionType: z.literal("workspace.create"), payload: workspaceCreatePayloadSchema }),
  z.object({ actionType: z.literal("workspace.update"), payload: workspaceUpdatePayloadSchema }),
  z.object({ actionType: z.literal("agent.connect"), payload: agentConnectPayloadSchema }),
  z.object({ actionType: z.literal("agent.update"), payload: agentUpdatePayloadSchema }),
  z.object({ actionType: z.literal("credential.rotate"), payload: credentialRotatePayloadSchema }),
  z.object({ actionType: z.literal("credential.revoke"), payload: credentialRevokePayloadSchema }),
]);

export const proposeAdminActionSchema = z.object({
  requestId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
  action: adminActionProposalSchema,
}).strict();

export const reviewAdminActionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict();

export type AdminActionProposal = z.infer<typeof adminActionProposalSchema>;
export type ProposeAdminActionInput = z.infer<typeof proposeAdminActionSchema>;
export type ReviewAdminActionInput = z.infer<typeof reviewAdminActionSchema>;
