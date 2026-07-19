import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  createLangChainChatModel,
  type LangChainModelExecutionConfig,
  type ObserveSink,
} from "@sourceweft/model-gateway";
import { and, eq } from "drizzle-orm";
import { db, modelGatewayProfiles } from "@sourceweft/db";
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

async function findActiveModelGatewayProfileRow(input: {
  kind: ModelGatewayProfileKind;
  profileAlias: string;
}) {
  const [row] = await db
    .select()
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.kind),
        eq(modelGatewayProfiles.profileAlias, input.profileAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function findActiveModelGatewayProfileRowByModelAlias(input: {
  kind: ModelGatewayProfileKind;
  modelAlias: string;
}) {
  const [row] = await db
    .select()
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.kind),
        eq(modelGatewayProfiles.modelAlias, input.modelAlias),
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

/**
 * Fans one generation event out to several sinks. Used so a caller can observe
 * its own calls without displacing the observability sink that persists them.
 * A failing sink is isolated: it must not stop the others or the model call.
 */
function composeObserveSinks(sinks: ObserveSink[]): ObserveSink {
  const call = async (
    handler: keyof ObserveSink,
    event: never,
  ): Promise<void> => {
    for (const sink of sinks) {
      try {
        await sink[handler]?.(event);
      } catch {
        // Observation must never break the call it is observing.
      }
    }
  };

  return {
    onSpan: (event) => call("onSpan", event as never),
    onGenerationStart: (event) => call("onGenerationStart", event as never),
    onGenerationEnd: (event) => call("onGenerationEnd", event as never),
    onGenerationError: (event) => call("onGenerationError", event as never),
  };
}

export async function createAgentChatModel(input: {
  modelAlias: string;
  gatewayConfigId?: string | null;
  execution?: LangChainModelExecutionConfig;
  /**
   * Additional per-call sink, composed with (never replacing) the configured
   * observability sink. The billed wrapper uses this to capture usage.
   */
  observeSink?: ObserveSink;
}): Promise<BaseLanguageModel> {
  const routedConfig = await loadRoutedGatewayConfig();
  if (!routedConfig) {
    throw new Error("Global model gateway configuration is not synchronized");
  }

  assertGatewayConfigAvailable(routedConfig, input.gatewayConfigId);

  const config = buildRoutedModelGatewayConfig(routedConfig);

  return createLangChainChatModel({
    modelAlias: input.modelAlias,
    config: input.observeSink
      ? {
          ...config,
          observeSink: config.observeSink
            ? composeObserveSinks([config.observeSink, input.observeSink])
            : input.observeSink,
        }
      : config,
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

export async function resolveModelGatewayProfile(input: {
  kind: ModelGatewayProfileKind;
  requestedProfileAlias?: string | null;
  requestedModelAlias?: string | null;
  defaultRequired?: boolean;
}) {
  const requestedProfileAlias = input.requestedProfileAlias?.trim();
  const requestedModelAlias = input.requestedModelAlias?.trim();
  const row = requestedProfileAlias
    ? await findActiveModelGatewayProfileRow({
        kind: input.kind,
        profileAlias: requestedProfileAlias,
      })
    : requestedModelAlias
      ? await findActiveModelGatewayProfileRowByModelAlias({
          kind: input.kind,
          modelAlias: requestedModelAlias,
        })
      : await findDefaultModelGatewayProfileRow(input.kind);

  if (!row && input.defaultRequired !== false) {
    throw new Error(
      requestedProfileAlias
        ? `${input.kind} model gateway profile '${requestedProfileAlias}' is not configured`
        : requestedModelAlias
          ? `${input.kind} model gateway model '${requestedModelAlias}' is not configured`
        : `Default ${input.kind} model gateway profile is not configured`,
    );
  }

  return row ? mapModelGatewayProfile(row) : null;
}

