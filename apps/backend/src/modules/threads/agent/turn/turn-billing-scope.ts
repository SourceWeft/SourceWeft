import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { logger } from "../../../../shared/logger";
import { openBilledModelGateway } from "../../../../shared/model-gateway/index";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { TraceContext } from "../../../llm-observability";
import { workspaceService } from "../../../workspace";
import type { PreparedThreadTurn } from "../..";
import type { TurnRuntime } from "./turn-runtime";

/**
 * Opens the billing scope for an agent turn and returns the chat model that
 * settles against it.
 *
 * The scope is the single source of truth for what this turn billed: it
 * outlives the turn generator, so it still carries the metered calls when a
 * turn crashes partway through and no outcome is ever produced.
 */
export async function openTurnBillingScope(input: {
  prepared: PreparedThreadTurn;
  billing: ContentBillingPort;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
  runtime: TurnRuntime;
}): Promise<BaseLanguageModel> {
  const { prepared } = input;
  const isByok = input.llm?.executionMode === "BYOK";

  // 谁问谁付: a guest's turn bills the guest's own personal org, not the host
  // team. Members bill the workspace's org, unchanged.
  const billingTeamId = await workspaceService.resolveBillingOrganizationId({
    workspaceId: prepared.workspace.id,
    userId: prepared.userId,
    workspaceOrganizationId: prepared.workspace.organizationId,
  });

  const { gateway, scope } = await openBilledModelGateway({
    billing: input.billing,
    gatewayConfigId: prepared.chatProfile.gatewayConfigId,
    context: {
      teamId: billingTeamId,
      workspaceId: prepared.workspace.id,
      actorUserId: prepared.userId,
      feature: "chat",
      // A customer-supplied key means there is no provider cost to pass on,
      // but the call is still traced and its usage recorded.
      intent: isByok
        ? { mode: "covered", coveredBy: "byok" }
        : { mode: "billed" },
      scopeKind: "thread-turn",
      // runTraceId is non-optional and assigned by the preparer, unlike
      // traceContext.traceId which the stream service fills in later.
      scopeId: input.traceContext?.traceId ?? prepared.runTraceId,
      threadId: prepared.thread.id,
      messageId: prepared.userMessage.id,
    },
  });

  const model = await gateway.agentChatModel({
    modelAlias: prepared.providerModel,
    observationContext: {
      traceId: input.traceContext?.traceId ?? prepared.runTraceId,
      parentSpanId: input.traceContext?.parentSpanId,
      teamId: prepared.workspace.organizationId,
      workspaceId: prepared.workspace.id,
      userId: prepared.userId,
      threadId: prepared.thread.id,
      messageId: prepared.userMessage.id,
      feature: "chat",
    },
    execution: {
      executionMode: input.llm?.executionMode,
      profileAlias: isByok ? undefined : prepared.profileAlias,
      providerHint: input.llm?.providerHint,
      byokModelId: input.llm?.byokModelId,
      credentialId: input.llm?.credentialId,
      byok: input.llm?.byok,
      thinking: input.llm?.thinking,
    },
    billing: {
      modelKind: "chat",
      gatewayConfigId: prepared.chatProfile.gatewayConfigId,
      profileAlias: prepared.profileAlias,
      modelAlias: prepared.modelAlias,
      llm: input.llm,
    },
  });

  input.runtime.billingScope = scope;

  logger.debug("Agent turn billing scope opened", {
    teamId: billingTeamId,
    threadId: prepared.thread.id,
    scopeId: input.traceContext?.traceId ?? prepared.runTraceId,
    billingMode: scope.billingMode,
  });

  return model;
}
