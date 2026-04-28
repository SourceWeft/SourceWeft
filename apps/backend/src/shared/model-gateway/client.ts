import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  createLangChainChatModel,
  type LangChainModelExecutionConfig,
} from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { db } from "../database";
import { modelGatewayProfiles } from "../db/schema";
import { mapModelGatewayProfile } from "./profiles";
import {
  assertGatewayConfigAvailable,
  buildRoutedModelGatewayConfig,
  findActiveConfigVersionRow,
  getOrCreateRoutedGatewayClient,
  loadRoutedGatewayConfig,
} from "./runtime";
import type { ModelGatewayProfileKind } from "./types";

async function findDefaultModelGatewayProfileRow(kind: ModelGatewayProfileKind) {
  const [row] = await db
    .select()
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, kind),
        eq(modelGatewayProfiles.isDefault, true),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function ensureModelConfigAvailable() {
  const deadline = Date.now() + 30_000;

  while (Date.now() <= deadline) {
    const activeVersion = await findActiveConfigVersionRow();
    if (activeVersion) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    "Global model gateway configuration is not synchronized. Start the scheduler or run the model gateway sync before starting API/worker.",
  );
}

export async function getModelGatewayClient(gatewayConfigId?: string | null) {
  const routedConfig = await loadRoutedGatewayConfig();
  if (!routedConfig) {
    throw new Error("Global model gateway configuration is not synchronized");
  }

  assertGatewayConfigAvailable(routedConfig, gatewayConfigId);

  return getOrCreateRoutedGatewayClient(routedConfig);
}

export async function createAgentChatModel(input: {
  modelAlias: string;
  gatewayConfigId?: string | null;
  execution?: LangChainModelExecutionConfig;
}): Promise<BaseLanguageModel> {
  const routedConfig = await loadRoutedGatewayConfig();
  if (!routedConfig) {
    throw new Error("Global model gateway configuration is not synchronized");
  }

  assertGatewayConfigAvailable(routedConfig, input.gatewayConfigId);

  return createLangChainChatModel({
    modelAlias: input.modelAlias,
    config: buildRoutedModelGatewayConfig(routedConfig),
    execution: input.execution,
  });
}

export async function requireDefaultModelGatewayProfile(
  kind: ModelGatewayProfileKind,
) {
  const row = await findDefaultModelGatewayProfileRow(kind);
  if (!row) {
    throw new Error(`Default ${kind} model gateway profile is not configured`);
  }

  return mapModelGatewayProfile(row);
}
