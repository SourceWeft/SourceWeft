import { z } from "zod";
import {
  connectorActionRiskLevelSchema,
  connectorActionRunStatusSchema,
} from "./connectors";

const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * `approve_always` behaves exactly like `approve` for the action in front of the
 * user, and additionally persists an `agent_tool_trust_rules` row so a later
 * identical action skips the prompt. It is a separate decision rather than a
 * flag on `approve` so that every producer of a confirmation must opt in by
 * listing it in `decisionOptions`: a surface that never offers the option can
 * never have a trust rule created from it.
 */
export const toolConfirmationDecisionSchema = z.enum([
  "approve",
  "reject",
  "approve_always",
]);

/**
 * How wide the persisted trust rule should be. The values map 1:1 onto the
 * columns `findAgentToolTrustRuleRecord` matches on, and nothing else — the
 * repository query is the spec here:
 *
 * - `tool`   -> (workspace, user, domain, toolName, connectorId), target NULL.
 * - `target` -> the above plus (targetType, targetId) from the confirmation.
 *
 * There is deliberately no "any connector" or "any tool" value: the repository
 * compares `connectorId` and `toolName` for exact equality, so a wider rule
 * would simply never match and would read to the user as a broader grant than
 * it actually is. The concrete scope values are always derived server-side from
 * the confirmation being answered — the client picks granularity, never the
 * subject of the grant.
 */
export const toolTrustRuleScopeSchema = z.enum(["tool", "target"]);

/**
 * Expiry policy for standing approvals, published here so that the server, the
 * SDK and any UI that offers a duration all read the same two numbers. A client
 * that hard-coded them would keep offering "90 days" after the server started
 * clamping to less.
 *
 * The server is still the authority: it clamps whatever arrives into this
 * window and substitutes the default when `ttlSeconds` is omitted.
 */
export const AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Trust rules are a standing bypass of a human approval gate, so the wire
 * format makes expiry the normal case: callers may shorten the TTL but the
 * server applies a bounded default when this is omitted. `ttlSeconds` is capped
 * here as well as on the server so an obviously bogus value is rejected before
 * it reaches the database.
 */
export const respondAgentConfirmationTrustSchema = z.object({
  scope: toolTrustRuleScopeSchema.optional(),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS)
    .optional(),
});

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

// A proactive `askUser` answer is resumed here too — it rides the same replay
// route as approvals, but is NOT a decision (JS langchain has no `respond`
// decision, and a question has no side effect). Exactly one of `decisions` /
// `askUser` is populated per resume; see docs/architecture/proactive-ask-user.md.
export const askUserResumeAnswerSchema = z.object({
  status: z.enum(["answered", "cancelled"]),
  answers: z.array(z.string()).optional(),
  /**
   * LangGraph interrupt id echoed from the question request. When present the
   * resume is keyed by it (so a sub-agent / parallel interrupt resumes the right
   * pending task); when absent the bare single-interrupt resume is used.
   */
  interruptId: z.string().min(1).optional(),
});

export const toolApprovalResumeSchema = z
  .object({
    decisions: z.array(toolApprovalResumeDecisionSchema).default([]),
    askUser: askUserResumeAnswerSchema.optional(),
    sourceweft: z
    .object({
      connectorActions: z
        .array(
          z.object({
            toolName: z.string().min(1),
            connectorId: z.string().min(1),
            actionRunId: z.string().min(1),
            requestJson: jsonObjectSchema.optional(),
          }),
        )
        .optional(),
      // Approved MCP calls resumed as args-matched execution refs, mirroring
      // connectorActions. The wrapped MCP tool resolves an approved ref by args
      // (never by tool-call id), so an interrupt raised inside a sub-agent
      // subgraph — whose tool-call id never surfaces in the top-level graph —
      // resumes correctly. Retry-idempotency of the external call stays keyed on
      // the execution-time tool-call id, independently of this approval channel.
      mcpActions: z
        .array(
          z.object({
            toolName: z.string().min(1),
            actionRunId: z.string().min(1),
            requestJson: jsonObjectSchema,
          }),
        )
        .optional(),
      sandboxActions: z
        .array(
          z.object({
            toolName: z.string().min(1),
            toolCallId: z.string().min(1),
            requestJson: jsonObjectSchema,
            confirmationId: z.string().min(1).optional(),
            hitlInterruptId: z.string().min(1).optional(),
            sourceUserMessageId: z.string().min(1).optional(),
            sourceAssistantMessageId: z.string().min(1).optional(),
          }),
        )
        .optional(),
      hitlInterruptId: z.string().min(1).optional(),
      confirmationId: z.string().min(1).optional(),
      sourceUserMessageId: z.string().min(1).optional(),
      sourceAssistantMessageId: z.string().min(1).optional(),
    })
    .optional(),
  })
  .refine((resume) => (resume.decisions.length > 0) !== Boolean(resume.askUser), {
    message:
      "toolApprovalResume must carry either approval decisions or an askUser answer, not both",
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
    description: z.string().min(1).optional(),
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
    sourceweft: z
      .object({
        toolCallId: z.string().min(1).optional(),
        hitlInterruptId: z.string().min(1).optional(),
        actionIndex: z.number().int().nonnegative().optional(),
        toolName: z.string().min(1).optional(),
        requestJson: jsonObjectSchema.optional(),
        hitlActionIndex: z.number().int().nonnegative().optional(),
        hitlActionToolName: z.string().min(1).optional(),
        hitlActionRequestJson: jsonObjectSchema.optional(),
        confirmationId: z.string().min(1).optional(),
        sourceUserMessageId: z.string().min(1).optional(),
        sourceAssistantMessageId: z.string().min(1).optional(),
      })
      .optional(),
  }),
  status: toolConfirmationStatusSchema,
  userMessage: z.string().min(1),
});

export const respondAgentConfirmationRequestSchema = z.object({
  decision: toolConfirmationDecisionSchema,
  editedArgs: jsonObjectSchema.optional(),
  note: z.string().trim().max(2000).optional(),
  confirmation: toolConfirmationRequestSchema.optional(),
  threadRunId: z.string().trim().min(1).max(128).optional(),
  assistantMessageId: z.string().trim().min(1).max(128).optional(),
  /**
   * Only read when `decision === "approve_always"`. Carries granularity and TTL
   * only; the workspace, team, user, domain, tool, connector and risk level of
   * the resulting rule are all derived server-side from the action the server
   * itself resolved, never from this payload. If a client could name those, it
   * could mint a trust rule for a tool it was never shown.
   */
  trust: respondAgentConfirmationTrustSchema.optional(),
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
  /**
   * Present only when an `approve_always` decision actually persisted a rule.
   * Absent means no standing grant was created, which is the signal the UI needs
   * to avoid telling the user it will remember something it did not.
   */
  trustRule: agentToolTrustRuleSchema.optional(),
});

export const listAgentToolTrustRulesResponseSchema = z.object({
  rules: z.array(agentToolTrustRuleSchema),
});

export const revokeAgentToolTrustRuleResponseSchema = z.object({
  rule: agentToolTrustRuleSchema,
});

export function isPendingToolConfirmation(confirmation: unknown) {
  if (
    !confirmation ||
    typeof confirmation !== "object" ||
    Array.isArray(confirmation)
  ) {
    return false;
  }
  return (confirmation as { status?: unknown }).status === "proposed";
}

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
export type ToolTrustRuleScope = z.infer<typeof toolTrustRuleScopeSchema>;
export type RespondAgentConfirmationTrust = z.infer<
  typeof respondAgentConfirmationTrustSchema
>;
export type ListAgentToolTrustRulesResponse = z.infer<
  typeof listAgentToolTrustRulesResponseSchema
>;
export type RevokeAgentToolTrustRuleResponse = z.infer<
  typeof revokeAgentToolTrustRuleResponseSchema
>;
export type ToolApprovalResume = z.infer<typeof toolApprovalResumeSchema>;
export type ToolApprovalResumeDecision = z.infer<
  typeof toolApprovalResumeDecisionSchema
>;
