import type { UsageInfo } from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../shared/database";
import {
  modelGatewayConfigs,
  modelGatewayProfiles,
} from "../../../../shared/db/schema";
import type { ModelPricing } from "../../../../shared/db/schema-types";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { ModelProfileKind } from "../model-settings";

export async function computeProviderCost(input: {
  gatewayConfigId: string;
  modelKind: ModelProfileKind;
  modelAlias: string;
  userContent: string;
  assistantContent: string;
  usage?: UsageInfo;
  llm?: LlmExecutionConfig;
}) {
  if (input.llm?.executionMode === "BYOK") {
    return 0;
  }

  const [gatewayRow] = await db
    .select({ isBYOK: modelGatewayConfigs.isBYOK })
    .from(modelGatewayConfigs)
    .where(eq(modelGatewayConfigs.id, input.gatewayConfigId))
    .limit(1);

  if (gatewayRow?.isBYOK) {
    return 0;
  }

  const [profileRow] = await db
    .select({ configJson: modelGatewayProfiles.configJson })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.modelKind),
        eq(modelGatewayProfiles.modelAlias, input.modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  const pricing = profileRow?.configJson as ModelPricing | undefined;
  if (!pricing || pricing.price_source === "unknown") {
    return 0;
  }

  const usage = input.usage;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (inputTokens === undefined || outputTokens === undefined) {
    return null;
  }

  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;

  const providerCostUsd =
    inputTokens * (pricing.input_cost_per_token ?? 0) +
    outputTokens * (pricing.output_cost_per_token ?? 0) +
    cacheReadTokens * (pricing.cache_read_input_token_cost ?? 0) +
    cacheWriteTokens * (pricing.cache_creation_input_token_cost ?? 0);

  return Number(providerCostUsd.toFixed(6));
}
