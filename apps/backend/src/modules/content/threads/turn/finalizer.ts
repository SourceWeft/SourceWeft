import type { ContentBillingPort } from "../../billing-port";
import type { MeterConsumeResponse } from "@sourceweft/contracts";
import { createCitationRecords } from "../../citations";
import {
  buildGatewayAuditMetadata,
  recordGatewayOperationEvent,
} from "../../model-gateway-audit";
import { createMessageRecord } from "../message-repository";
import { computeProviderCost } from "./cost";
import { summarizeRetrievalCalls } from "./retrieval-summary";
import type { FinalizeThreadTurnInput } from "./types";

async function zeroBillingResponse(input: {
  billing: ContentBillingPort;
  teamId: string;
}): Promise<MeterConsumeResponse> {
  const summary = await input.billing.getSummary(input.teamId);
  return {
    teamId: input.teamId,
    consumedCredits: 0,
    availableCredits: summary.credits.available,
    consumedThisCycle: summary.credits.consumedThisCycle,
    idempotencyReplayed: false,
  };
}

export async function finalizeThreadTurn(input: FinalizeThreadTurnInput) {
  const { prepared, retrieval } = input;
  const providerCostUsd = await computeProviderCost({
    gatewayConfigId: prepared.chatProfile.gatewayConfigId,
    modelKind: "chat",
    modelAlias: prepared.modelAlias,
    userContent: prepared.messageContent,
    assistantContent: input.assistantContent,
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
    llm: input.llm,
    provider: input.provider ?? null,
    providerModel: input.providerModel ?? null,
    routeDecision: input.routeDecision,
    usage: input.usage,
    providerCostUsd,
    traceId: prepared.userMessage.id,
    success: true,
    latencyMs: input.latencyMs,
    attributes: {
      retrievalCalls: summarizeRetrievalCalls(input.retrievalCalls),
    },
  });

  const billing = providerCostUsd && providerCostUsd > 0
    ? await input.billing.meterConsume(
        prepared.workspace.organizationId,
        {
          workspaceId: prepared.workspace.id,
          feature: "chat",
          referenceId: `thread:${prepared.thread.id}:message:${prepared.userMessage.id}`,
          idempotencyKey: prepared.llmIdempotencyKey,
          providerCostUsd,
          platformCostUsd: 0,
        },
        prepared.userId,
      )
    : await zeroBillingResponse({
        billing: input.billing,
        teamId: prepared.workspace.organizationId,
      });

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
      providerCostUsd,
      billingSkipped: !providerCostUsd || providerCostUsd <= 0,
      billingSkipReason:
        providerCostUsd === null
          ? "missing_usage"
          : providerCostUsd === 0
            ? "zero_provider_cost"
            : null,
      modelAlias: prepared.modelAlias,
      finishReason: input.finishReason,
      usage: input.usage,
      reasoning: input.reasoning,
      providerFields: input.providerFields,
      versionOf: prepared.assistantMessageParentId,
      gateway: buildGatewayAuditMetadata({
        llm: input.llm,
        provider: input.provider ?? undefined,
        providerModel: input.providerModel ?? undefined,
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
      chunkId: citation.chunkId,
      chunkNo: citation.chunkNo,
      excerpt: citation.excerpt,
      quoteText: citation.quoteText,
      rank: index + 1,
      score: citation.score,
    })),
  });

  return {
    assistantMessage,
    billing,
  };
}
