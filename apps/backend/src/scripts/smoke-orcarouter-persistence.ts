import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  closeDatabase,
  db,
  llmGenerations,
  modelGatewayProfiles,
} from "@sourceweft/db";
import { getModelGatewayClient } from "../shared/model-gateway/client";
import { processProviderCostReconciliationJob } from "../shared/model-gateway/provider-cost-reconciliation";

async function run() {
  const [scope] = await db
    .select({
      teamId: llmGenerations.teamId,
      workspaceId: llmGenerations.workspaceId,
      userId: llmGenerations.userId,
    })
    .from(llmGenerations)
    .where(isNotNull(llmGenerations.userId))
    .orderBy(desc(llmGenerations.startedAt))
    .limit(1);
  const [profile] = await db
    .select({ gatewayConfigId: modelGatewayProfiles.gatewayConfigId })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, "chat"),
        eq(modelGatewayProfiles.profileAlias, "chat-default"),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);
  if (!scope?.userId || !profile) {
    throw new Error(
      "No existing observation scope or chat-default profile is available",
    );
  }

  const traceId = `orca-observation-smoke-${randomUUID()}`;
  const client = await getModelGatewayClient(profile.gatewayConfigId);
  const result = await client.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "Reply with exactly: PERSIST_OK" }],
    maxTokens: 16,
    metadata: {
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      feature: "orcarouter-observation-smoke",
      modelKind: "chat",
      profileAlias: "chat-default",
      gatewayConfigId: profile.gatewayConfigId,
      traceId,
    },
  });
  const spanId = result.observation?.spanId;
  if (!spanId) {
    throw new Error("Smoke call did not return an observation span ID");
  }
  const [generation] = await db
    .select()
    .from(llmGenerations)
    .where(
      and(
        eq(llmGenerations.teamId, scope.teamId),
        eq(llmGenerations.workspaceId, scope.workspaceId),
        eq(llmGenerations.traceId, traceId),
        eq(llmGenerations.spanId, spanId),
      ),
    )
    .limit(1);
  if (
    !generation?.resolvedProviderModel ||
    !generation.providerRequestId ||
    !generation.providerCostInlineUsd ||
    generation.providerCostStatus !== "inline"
  ) {
    throw new Error(
      "Persisted generation is missing model/request/cost fields",
    );
  }
  console.log("persisted", {
    id: generation.id,
    modelAlias: generation.modelAlias,
    requestedProviderModel: generation.providerModel,
    resolvedProviderModel: generation.resolvedProviderModel,
    inputTokens: generation.inputTokens,
    outputTokens: generation.outputTokens,
    reasoningTokens: generation.reasoningTokens,
    totalTokens: generation.totalTokens,
    providerRequestId: generation.providerRequestId,
    inlineCostUsd: generation.providerCostInlineUsd,
    effectiveCostUsd: generation.providerCostUsd,
    costSource: generation.providerCostSource,
    costStatus: generation.providerCostStatus,
  });

  await processProviderCostReconciliationJob({
    data: {
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      feature: "orcarouter-observation-smoke",
      traceId,
      spanId,
      gatewayConfigId: profile.gatewayConfigId,
      provider: "orcarouter",
      providerRequestId: generation.providerRequestId,
    },
    opts: { attempts: 1 },
    attemptsMade: 0,
  } as never);
  const [settled] = await db
    .select()
    .from(llmGenerations)
    .where(eq(llmGenerations.id, generation.id))
    .limit(1);
  if (
    settled?.providerCostStatus !== "settled" ||
    settled.providerCostSource !== "provider_receipt" ||
    !settled.providerCostSettledUsd ||
    !settled.providerReceiptJson
  ) {
    throw new Error("Provider receipt reconciliation was not persisted");
  }
  console.log("settled", {
    resolvedProviderModel: settled.resolvedProviderModel,
    inlineCostUsd: settled.providerCostInlineUsd,
    settledCostUsd: settled.providerCostSettledUsd,
    effectiveCostUsd: settled.providerCostUsd,
    costSource: settled.providerCostSource,
    costStatus: settled.providerCostStatus,
  });
}

try {
  await run();
} finally {
  await closeDatabase();
}
