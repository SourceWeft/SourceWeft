import type { ContentBillingPort } from "../../billing-port";
import { createCitationRecords, replaceCitationRecords } from "../../citations";
import {
  buildGatewayAuditMetadata,
  recordGatewayOperationEvent,
} from "../../model-gateway-audit";
import { meterBillableModelUsage } from "../../model-billing";
import { consumeSourceWeftContextCompressionReport } from "../../agent/context-compression";
import {
  createMessageRecord,
  updateMessageRecord,
} from "../message-repository";
import { computeProviderCost } from "./cost";
import { summarizeRetrievalCalls } from "./retrieval-summary";
import type { FinalizeThreadTurnInput } from "./types";

export async function finalizeThreadTurn(input: FinalizeThreadTurnInput) {
  const { prepared, retrieval } = input;
  const preflightCreditsConsumed = prepared.preflightBilling.reduce(
    (sum, item) => sum + item.consumedCredits,
    0,
  );
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
  const {
    providerCostUsd,
    pricingSnapshot,
    costSource,
    missingPriceComponents,
  } = await computeProviderCost({
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
      costSource,
      missingPriceComponents,
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
      costSource,
      missingPriceComponents,
    },
  });
  const billing = billedUsage.billing;
  const totalCreditsConsumed =
    billing.consumedCredits + preflightCreditsConsumed;

  const assistantMetadata = {
    userMessageId: prepared.userMessage.id,
    sourceUserMessageId: prepared.userMessage.id,
    traceId: prepared.traceContext?.traceId ?? prepared.userMessage.id,
    providerCostUsd,
    costSource,
    missingPriceComponents,
    billingSkipped: billedUsage.billedBy === "skipped",
    billingSkipReason: billedUsage.skipReason,
    billedBy: billedUsage.billedBy,
    preflightBilling: prepared.preflightBilling,
    preflightCreditsConsumed,
    modelAlias: prepared.modelAlias,
    profileAlias: prepared.profileAlias,
    agentMode: prepared.agentMode,
    agentCheckpoint: input.agentCheckpoint ?? {
      beforeInput: null,
      beforeAssistant: null,
      resume: null,
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
    ...(input.renderBlocks && input.renderBlocks.length > 0
      ? { renderBlocks: input.renderBlocks }
      : {}),
    thinkingSteps: input.thinkingSteps,
    retrieval: {
      embeddingProfileId: retrieval?.profile.id ?? null,
      vectorStrategy: retrieval?.planner.strategy ?? null,
      annIndexUsed: retrieval?.planner.annIndexUsed ?? null,
      citations: input.citations,
      availableCitations: input.availableCitations ?? input.citations,
    },
    ...(input.assistantMetadata ?? {}),
  };

  const assistantMessage = input.assistantMessageId
    ? await updateMessageRecord({
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        threadId: prepared.thread.id,
        messageId: input.assistantMessageId,
        content: input.assistantContent,
        model: input.modelForMessage || prepared.modelAlias,
        creditsConsumed: totalCreditsConsumed,
        metadata: assistantMetadata,
      })
    : await createMessageRecord({
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        threadId: prepared.thread.id,
        parentMessageId: prepared.assistantMessageParentId,
        role: "assistant",
        content: input.assistantContent,
        createdBy: null,
        model: input.modelForMessage || prepared.modelAlias,
        creditsConsumed: totalCreditsConsumed,
        metadata: assistantMetadata,
      });

  if (!assistantMessage) {
    throw new Error("Failed to finalize assistant message");
  }

  const persistCitations = input.assistantMessageId
    ? replaceCitationRecords
    : createCitationRecords;
  await persistCitations({
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
