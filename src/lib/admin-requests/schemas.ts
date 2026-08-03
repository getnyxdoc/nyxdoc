import { z } from "zod";
import {
  AGENT_ACCESS_PROFILES,
  AGENT_NON_DELEGABLE_PERMISSIONS,
  WORKSPACE_PERMISSIONS,
} from "@/lib/authz/permissions";
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

const agentAccessFields = {
  accessProfile: z.enum(AGENT_ACCESS_PROFILES),
  capabilities: z.array(z.enum(WORKSPACE_PERMISSIONS)).min(1).max(WORKSPACE_PERMISSIONS.length).optional(),
};

function validateCustomCapabilities(
  value: { accessProfile?: (typeof AGENT_ACCESS_PROFILES)[number]; capabilities?: string[] },
  context: z.RefinementCtx,
) {
  if (value.accessProfile === "custom" && !value.capabilities?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "사용자 지정 접근 프로필에는 권한을 하나 이상 지정해야 합니다." });
  }
  if (value.accessProfile !== undefined && value.accessProfile !== "custom" && value.capabilities !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "기본 접근 프로필에는 개별 권한 목록을 함께 지정할 수 없습니다." });
  }
  const protectedCapability = value.capabilities?.find((capability) => AGENT_NON_DELEGABLE_PERMISSIONS.has(capability as never));
  if (protectedCapability) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: `사람에게만 허용된 보호 권한(${protectedCapability})은 에이전트에 부여할 수 없습니다.` });
  }
}

export const agentConnectPayloadSchema = z.object({
  ...agentAccessFields,
  name: z.string().trim().min(1).max(80),
  credentialName: z.string().trim().min(1).max(80).optional(),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1).max(API_TOKEN_SCOPES.length),
  rootDocumentId: z.string().uuid().nullable().optional(),
}).strict().superRefine((value, context) => {
  validateCustomCapabilities(value, context);
});

export const agentUpdatePayloadSchema = z.object({
  agentId: z.string().uuid(),
  accessProfile: z.enum(AGENT_ACCESS_PROFILES).optional(),
  capabilities: z.array(z.enum(WORKSPACE_PERMISSIONS)).min(1).max(WORKSPACE_PERMISSIONS.length).optional(),
  rootDocumentId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().superRefine((value, context) => {
  if (
    value.accessProfile === undefined
    && value.capabilities === undefined
    && value.rootDocumentId === undefined
    && value.status === undefined
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "변경할 워크스페이스 접근 정보를 하나 이상 입력해주세요." });
  }
  if (value.capabilities !== undefined && value.accessProfile === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["accessProfile"], message: "개별 권한 목록을 바꾸려면 접근 프로필을 custom으로 지정해야 합니다." });
  } else {
    validateCustomCapabilities(value, context);
  }
});

export const credentialRotatePayloadSchema = z.object({
  credentialId: z.string().uuid(),
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
