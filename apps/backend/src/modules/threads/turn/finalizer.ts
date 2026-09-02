import type { ContentBillingPort } from "../../content/billing-port";
import { workspaceService } from "../../workspace";
import { createCitationRecords, replaceCitationRecords } from "../../citations";
import {
  buildGatewayAuditMetadata,
  recordGatewayOperationEvent,
} from "../../content/model-gateway-audit";
import { consumeSourceWeftContextCompressionReport } from "../agent/middleware/context-compression";
import {
  createMessageRecord,
  findMessageRecord,
  updateMessageRecord,
} from "../message-repository";
import { computeProviderCost } from "./cost";
import { summarizeRetrievalCalls } from "./retrieval-summary";
import { preserveTraceMetadata } from "./trace-metadata";
import type { FinalizeThreadTurnInput } from "./types";

export function preserveAssistantMetadataForContinuation(input: {
  existingMetadata?: Record<string, unknown> | null;
  nextMetadata: Record<string, unknown>;
}) {
  return preserveTraceMetadata(input);
}

export function appendAssistantContinuationContent(input: {
  existingContent?: string | null;
  nextContent: string;
}) {
  const existingContent = input.existingContent?.trimEnd() ?? "";
  const nextContent = input.nextContent.trim();
  if (!existingContent) {
    return nextContent;
  }
  if (!nextContent) {
    return existingContent;
  }
  if (nextContent.startsWith(existingContent)) {
    return nextContent;
  }
  if (existingContent.endsWith(nextContent)) {
    return existingContent;
  }

  const maxOverlap = Math.min(existingContent.length, nextContent.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (existingContent.endsWith(nextContent.slice(0, length))) {
      return `${existingContent}${nextContent.slice(length)}`;
    }
  }

  return `${existingContent}\n${nextContent}`;
}

export async function finalizeThreadTurn(input: FinalizeThreadTurnInput) {
  const { prepared, retrieval } = input;
  const preflightCreditsConsumed = prepared.preflightBilling.reduce(
    (sum, item) => sum + item.consumedCredits,
    0,
  );
  const meteredLlmCalls = input.meteredLlmCalls ?? [];
  const meteredLlmCreditsConsumed = meteredLlmCalls.reduce(
    (sum, item) => sum + item.consumedCredits,
    0,
  );
  const contextCompression = consumeSourceWeftContextCompressionReport(
    prepared.userMessage.id,
  ) ?? {
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

  const totalCreditsConsumed =
    meteredLlmCreditsConsumed + preflightCreditsConsumed;
  // 谁问谁付: report the balance from the org that was actually billed (a guest's
  // own personal org, not the host team) so we never materialize a spurious
  // account for the actor in the workspace's team.
  const billingTeamId = await workspaceService.resolveBillingOrganizationId({
    workspaceId: prepared.workspace.id,
    userId: prepared.userId,
    workspaceOrganizationId: prepared.workspace.organizationId,
  });
  const billingSummary = await input.billing.getSummary(
    billingTeamId,
    prepared.userId,
  );
  const billing = {
    teamId: billingTeamId,
    consumedCredits: meteredLlmCreditsConsumed,
    availableCredits: billingSummary.credits.available,
    consumedThisCycle: billingSummary.credits.consumedThisCycle,
    idempotencyReplayed: meteredLlmCalls.some(
      (call) => call.billing?.idempotencyReplayed === true,
    ),
  };

  const existingAssistantMessage = input.assistantMessageId
    ? await findMessageRecord({
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        messageId: input.assistantMessageId,
      })
    : null;
  const existingThreadRun =
    existingAssistantMessage?.metadata?.threadRun &&
    typeof existingAssistantMessage.metadata.threadRun === "object" &&
    !Array.isArray(existingAssistantMessage.metadata.threadRun)
      ? (existingAssistantMessage.metadata.threadRun as Record<string, unknown>)
      : {};
  const existingDurationMs =
    typeof existingThreadRun.durationMs === "number" &&
    Number.isFinite(existingThreadRun.durationMs)
      ? existingThreadRun.durationMs
      : 0;
  const accumulatedDurationMs = existingDurationMs + input.latencyMs;

  const nextAssistantMetadata = {
    ...(input.assistantMetadata ?? {}),
    threadRun: {
      ...existingThreadRun,
      completedAt: new Date().toISOString(),
      durationMs: accumulatedDurationMs,
    },
    userMessageId: prepared.userMessage.id,
    sourceUserMessageId: prepared.userMessage.id,
    traceId: prepared.traceContext?.traceId ?? prepared.userMessage.id,
    providerCostUsd,
    costSource,
    missingPriceComponents,
    billingFinalizerSkipped: true,
    billingFinalizerSkipReason: "llm_call_level_metering",
    meteredLlmCalls,
    meteredLlmCreditsConsumed,
    billingSkipped:
      meteredLlmCalls.length === 0 ||
      meteredLlmCalls.every((call) => call.billingStatus === "skipped"),
    billingSkipReason:
      meteredLlmCalls.length === 0
        ? "no_metered_llm_calls"
        : meteredLlmCalls.every((call) => call.billingStatus === "skipped")
          ? (meteredLlmCalls
              .map((call) => call.skipReason)
              .find((reason): reason is string => Boolean(reason)) ??
            "llm_calls_skipped")
          : null,
    billedBy: meteredLlmCalls
      .map((call) => call.billedBy)
      .find((billedBy) => billedBy && billedBy !== "skipped"),
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
    traceParts: input.traceParts,
    traceEvents: Array.isArray(input.assistantMetadata?.traceEvents)
      ? input.assistantMetadata.traceEvents
      : undefined,
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
      ...(call.approvalState ? { approvalState: call.approvalState } : {}),
      ...(call.approvalConfirmationId
        ? { approvalConfirmationId: call.approvalConfirmationId }
        : {}),
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
  };
  const assistantContent = input.assistantMessageId
    ? appendAssistantContinuationContent({
        existingContent: existingAssistantMessage?.content,
        nextContent: input.assistantContent,
      })
    : input.assistantContent;
  const assistantMetadata = preserveAssistantMetadataForContinuation({
    existingMetadata: existingAssistantMessage?.metadata,
    nextMetadata: nextAssistantMetadata,
  });

  const assistantMessage = input.assistantMessageId
    ? await updateMessageRecord({
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        threadId: prepared.thread.id,
        messageId: input.assistantMessageId,
        content: assistantContent,
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
        content: assistantContent,
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

export const testExports = {
  appendAssistantContinuationContent,
  preserveAssistantMetadataForContinuation,
};
