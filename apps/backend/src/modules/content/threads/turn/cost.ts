import type { UsageInfo } from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../shared/database";
import {
  modelGatewayConfigs,
  modelGatewayProfiles,
} from "../../../../shared/db/schema";
import type { ModelPricing } from "../../../../shared/db/schema-types";
import type { ModelProfileKind } from "../model-settings";

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function computeProviderCost(input: {
  gatewayConfigId: string;
  modelKind: ModelProfileKind;
  modelAlias: string;
  userContent: string;
  assistantContent: string;
  usage?: UsageInfo;
}) {
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
  const inputTokens = usage?.inputTokens ?? estimateTokens(input.userContent);
  const outputTokens =
    usage?.outputTokens ?? estimateTokens(input.assistantContent);
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;

  const providerCostUsd =
    inputTokens * (pricing.input_cost_per_token ?? 0) +
    outputTokens * (pricing.output_cost_per_token ?? 0) +
    cacheReadTokens * (pricing.cache_read_input_token_cost ?? 0) +
    cacheWriteTokens * (pricing.cache_creation_input_token_cost ?? 0);

  return Number(providerCostUsd.toFixed(6));
}
