import type { ContentBillingPort } from "../../billing-port";
import { createCitationRecords } from "../../citations";
import {
  buildGatewayAuditMetadata,
  recordGatewayOperationEvent,
} from "../../model-gateway-audit";
import { meterBillableModelUsage } from "../../model-billing";
import { consumeSourceWeftContextCompressionReport } from "../../agent/context-compression";
import { createMessageRecord } from "../message-repository";
import { computeProviderCost } from "./cost";
import { summarizeRetrievalCalls } from "./retrieval-summary";
import type { FinalizeThreadTurnInput } from "./types";

export async function finalizeThreadTurn(input: FinalizeThreadTurnInput) {
  const { prepared, retrieval } = input;
  const contextCompression =
    consumeSourceWeftContextCompressionReport(prepared.userMessage.id) ?? {
      enabled: false,
      contextEditingEnabled: false,
      toolPruned: false,
      summarized: false,
      summaryModelAlias: null,
      estimatedInputTokensBefore: null,
      estimatedInputTokensAfter: null,
      retainedMessageCount: null,
      triggerReason: "not_recorded",
      prunedToolCount: 0,
      contextLength: 0,
      usableInputTokens: 0,
    };
  const { providerCostUsd, pricingSnapshot } = await computeProviderCost({
    gatewayConfigId: prepared.chatProfile.gatewayConfigId,
    modelKind: "chat",
    profileAlias: prepared.profileAlias,
    usage: input.usage,
    llm: input.llm,
  });

  await recordGatewayOperationEvent({
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    userId: prepared.userId,
    threadId: prepared.thread.id,
    messageId: prepared.userMessage.id,
    feature: "chat",
    operation: input.operation,
    modelKind: "chat",
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
    llm: input.llm,
    provider: input.provider ?? null,
    routeDecision: input.routeDecision,
    usage: input.usage,
    providerCostUsd,
    traceId: prepared.traceContext?.traceId ?? prepared.userMessage.id,
    success: true,
    latencyMs: input.latencyMs,
    attributes: {
      pricingSnapshot,
      retrievalCalls: summarizeRetrievalCalls(input.retrievalCalls),
    },
  });

  const billedUsage = await meterBillableModelUsage({
    billing: input.billing,
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    actorUserId: prepared.userId,
    feature: "chat",
    operation: input.operation,
    modelKind: "chat",
    gatewayConfigId: prepared.chatProfile.gatewayConfigId,
    profileAlias: prepared.profileAlias,
    modelAlias: prepared.modelAlias,
    referenceId: `thread:${prepared.thread.id}:message:${prepared.userMessage.id}`,
    idempotencyKey: prepared.llmIdempotencyKey,
    usage: input.usage,
    llm: input.llm,
    metadata: {
      traceId: prepared.traceContext?.traceId ?? prepared.userMessage.id,
      threadId: prepared.thread.id,
      messageId: prepared.userMessage.id,
      pricingSnapshot,
    },
  });
  const billing = billedUsage.billing;

  const assistantMessage = await createMessageRecord({
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    threadId: prepared.thread.id,
    parentMessageId: prepared.assistantMessageParentId,
    role: "assistant",
    content: input.assistantContent,
    createdBy: null,
    model: input.modelForMessage || prepared.modelAlias,
    creditsConsumed: billing.consumedCredits,
    metadata: {
      userMessageId: prepared.userMessage.id,
      sourceUserMessageId: prepared.userMessage.id,
      traceId: prepared.traceContext?.traceId ?? prepared.userMessage.id,
      providerCostUsd,
      billingSkipped: billedUsage.billedBy === "skipped",
      billingSkipReason: billedUsage.skipReason,
      billedBy: billedUsage.billedBy,
      modelAlias: prepared.modelAlias,
      profileAlias: prepared.profileAlias,
      agentMode: prepared.agentMode,
      agentCheckpoint: input.agentCheckpoint ?? {
        beforeInput: null,
        beforeAssistant: null,
        final: null,
      },
      finishReason: input.finishReason,
      usage: input.usage,
      reasoning: input.reasoning,
      reasoningSegments: input.reasoningSegments,
      contextCompression,
      versionOf: prepared.assistantMessageParentId,
      gateway: buildGatewayAuditMetadata({
        llm: input.llm,
        provider: input.provider ?? undefined,
        routeDecision: input.routeDecision,
      }),
      toolCalls: input.toolCalls.map((call) => ({
        id: call.id,
        tool: call.tool,
        input: call.input,
        output: call.output,
        status: call.status,
        latencyMs: call.latencyMs,
        error: call.error,
        sequence: call.sequence,
      })),
      thinkingSteps: input.thinkingSteps,
      retrieval: {
        embeddingProfileId: retrieval?.profile.id ?? null,
        vectorStrategy: retrieval?.planner.strategy ?? null,
        annIndexUsed: retrieval?.planner.annIndexUsed ?? null,
        citations: input.citations,
        availableCitations: input.availableCitations ?? input.citations,
      },
    },
  });

  await createCitationRecords({
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    threadId: prepared.thread.id,
    messageId: assistantMessage.id,
    citations: input.citations.map((citation, index) => ({
      citationKey: citation.citation,
      sourceId: citation.sourceId,
      sourceTitle: citation.sourceTitle,
      documentId: citation.documentId,
      chunkId: citation.externalUri ? null : citation.chunkId,
      chunkNo: citation.chunkNo,
      excerpt: citation.excerpt,
      quoteText: citation.quoteText,
      rank: index + 1,
      score: citation.score,
      externalUri: citation.externalUri,
      content: citation.content,
    })),
  });

  return {
    assistantMessage,
    billing,
  };
}
