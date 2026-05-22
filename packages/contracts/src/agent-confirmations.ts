import { z } from "zod";
import {
  connectorActionRiskLevelSchema,
  connectorActionRunStatusSchema,
} from "./connectors";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const toolConfirmationDecisionSchema = z.enum([
  "approve",
  "reject",
]);

export const toolApprovalResumeDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approve"),
  }),
  z.object({
    type: z.literal("edit"),
    editedAction: z.object({
      name: z.string().min(1),
      args: jsonObjectSchema,
    }),
  }),
  z.object({
    type: z.literal("reject"),
    message: z.string().trim().max(2000).optional(),
  }),
]);

export const toolApprovalResumeSchema = z.object({
  decisions: z.array(toolApprovalResumeDecisionSchema).min(1),
  sourceweft: z
    .object({
      connectorActions: z
        .array(
          z.object({
            toolName: z.string().min(1),
            connectorId: z.string().min(1),
            actionRunId: z.string().min(1),
          }),
        )
        .optional(),
    })
    .optional(),
});

export const toolConfirmationDomainSchema = z.enum([
  "connector",
  "workfile",
  "source",
  "artifact",
  "mcp",
  "skill",
]);

export const toolConfirmationStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export const toolConfirmationExecutorSchema = z.union([
  z.object({
    kind: z.literal("connector_action_run"),
    connectorId: z.string().min(1),
    actionRunId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("mcp_action_run"),
    actionRunId: z.string().min(1),
  }),
  z.object({
    kind: z.string().min(1),
  }),
]);

export const toolConfirmationTargetSchema = z.object({
  type: z.string().min(1),
  label: z.string().min(1),
  id: z.string().nullable().optional(),
  externalUri: z.string().nullable().optional(),
});

export const toolConfirmationRequestSchema = z.object({
  type: z.literal("tool_confirmation_request"),
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  domain: toolConfirmationDomainSchema.or(z.string().min(1)),
  subject: z.object({
    label: z.string().min(1),
    provider: z.string().min(1).optional(),
    connectorId: z.string().min(1).optional(),
    externalUri: z.string().nullable().optional(),
  }),
  action: z.object({
    type: z.string().min(1),
    toolName: z.string().min(1),
    label: z.string().min(1),
    riskLevel: connectorActionRiskLevelSchema,
    status: toolConfirmationStatusSchema.or(connectorActionRunStatusSchema),
    requiresApproval: z.literal(true),
  }),
  preview: z.object({
    title: z.string().min(1),
    summary: z.string().optional(),
    target: toolConfirmationTargetSchema.optional(),
    requestJson: jsonObjectSchema.optional(),
  }),
  editableArgs: z
    .object({
      value: jsonObjectSchema,
      schema: jsonObjectSchema.optional(),
    })
    .optional(),
  decisionOptions: z.array(
    z.object({
      decision: toolConfirmationDecisionSchema,
      label: z.string().min(1),
      description: z.string().optional(),
    }),
  ),
  execution: z.object({
    providerStatus: z.enum([
      "not_executed",
      "running",
      "succeeded",
      "failed",
      "not_applicable",
    ]),
    executor: toolConfirmationExecutorSchema,
  }),
  status: toolConfirmationStatusSchema,
  userMessage: z.string().min(1),
});

export const respondAgentConfirmationRequestSchema = z.object({
  decision: toolConfirmationDecisionSchema,
  editedArgs: jsonObjectSchema.optional(),
  note: z.string().trim().max(2000).optional(),
  confirmation: toolConfirmationRequestSchema.optional(),
});

export const agentToolTrustRuleSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  domain: z.string(),
  toolName: z.string(),
  connectorId: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  allowedRiskLevels: z.array(connectorActionRiskLevelSchema),
  status: z.enum(["active", "revoked"]),
  expiresAt: z.string().nullable(),
  createdFromConfirmationId: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const respondAgentConfirmationResponseSchema = z.object({
  confirmation: toolConfirmationRequestSchema,
  resume: toolApprovalResumeSchema.optional(),
});

export type ToolConfirmationDecision = z.infer<
  typeof toolConfirmationDecisionSchema
>;
export type ToolConfirmationRequest = z.infer<
  typeof toolConfirmationRequestSchema
>;
export type RespondAgentConfirmationRequest = z.infer<
  typeof respondAgentConfirmationRequestSchema
>;
export type RespondAgentConfirmationResponse = z.infer<
  typeof respondAgentConfirmationResponseSchema
>;
export type AgentToolTrustRule = z.infer<typeof agentToolTrustRuleSchema>;
export type ToolApprovalResume = z.infer<typeof toolApprovalResumeSchema>;
export type ToolApprovalResumeDecision = z.infer<
  typeof toolApprovalResumeDecisionSchema
>;
