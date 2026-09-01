import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type {
  AsrTranscribeInput,
  AsrTranscribeResult,
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  ImageGenerateInput,
  ImageGenerateResult,
  LangChainModelExecutionConfig,
  ModelGateway,
  RerankInput,
  RerankResult,
  RequestOptions,
  TtsSpeechInput,
  TtsSpeechResult,
  UsageInfo,
  ModelCallObservation,
} from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "../../modules/content/billing-port";
import {
  admitCoveredScope,
  billingAdmission,
  BillingAdmissionError,
} from "./billing/admission";
import type {
  ModelCallBillingOptions,
  ModelUsageContext,
} from "./billing/context";
import { openBillingScope, type BillingScope } from "./billing/scope";
import type { MeterUsageFn } from "./billing/settle";
import { createBilledAgentChatModel } from "./billing/langchain-proxy";
import { getRawModelGatewayClient } from "./internal/raw";
import { enqueueProviderCostReconciliation } from "./provider-cost-reconciliation";
import type { ThinkingConfig } from "@sourceweft/model-gateway";
import { logger } from "../logger";
import { resolveChatThinkingWithDefaults } from "./thinking-defaults";

/**
 * Per-call options for a billed gateway call.
 *
 * `metadata` is deliberately omitted from what callers may pass: the wrapper
 * synthesises it from the scope, so a call site cannot attribute usage to a
 * different team, or omit the identity the cost lookup needs.
 */
export type BilledRequestOptions = Omit<RequestOptions, "metadata"> &
  ModelCallBillingOptions;

export type BilledModelGateway = {
  chat: {
    complete(
      input: ChatCompleteInput,
      options: BilledRequestOptions,
    ): Promise<ChatCompleteResult>;
    stream(
      input: ChatStreamInput,
      options: BilledRequestOptions,
    ): AsyncIterable<ChatStreamEvent>;
  };
  embeddings: {
    embed(
      input: EmbedInput,
      options: BilledRequestOptions,
    ): Promise<EmbedResult>;
    embedBatch(
      input: EmbedBatchInput,
      options: BilledRequestOptions,
    ): Promise<EmbedBatchResult>;
  };
  rerank: {
    rank(
      input: RerankInput,
      options: BilledRequestOptions,
    ): Promise<RerankResult>;
  };
  asr: {
    transcribe(
      input: AsrTranscribeInput,
      options: BilledRequestOptions,
    ): Promise<AsrTranscribeResult>;
  };
  tts: {
    speech(
      input: TtsSpeechInput,
      options: BilledRequestOptions,
    ): Promise<TtsSpeechResult>;
  };
  images: {
    generate(
      input: ImageGenerateInput,
      options: BilledRequestOptions,
    ): Promise<ImageGenerateResult>;
  };
  agentChatModel(input: {
    modelAlias: string;
    execution?: LangChainModelExecutionConfig;
    billing: Omit<ModelCallBillingOptions, "operation">;
  }): Promise<BaseLanguageModel>;
};

function splitOptions(options: BilledRequestOptions) {
  const {
    operation,
    modelKind,
    profileAlias,
    modelAlias,
    gatewayConfigId,
    llm,
    idempotencyKey,
    scopeKey,
    referenceId,
    billingMetadata,
    ...requestOptions
  } = options;

  return {
    billingOptions: {
      operation,
      modelKind,
      profileAlias,
      modelAlias,
      gatewayConfigId,
      llm,
      idempotencyKey,
      scopeKey,
      referenceId,
      billingMetadata,
    } satisfies ModelCallBillingOptions,
    requestOptions,
  };
}

/**
 * The one best-effort wrapper around the thinking-support resolver, shared by
 * the chat inputs and agentChatModel so the swallow policy and identifier
 * precedence live in exactly one place. A lookup failure never breaks the
 * model call it decorates — the caller's own thinking rides unchanged — but
 * it is logged: silently losing the fill fleet-wide during a DB outage was
 * how the last thinking incident stayed invisible.
 */
async function resolveThinkingBestEffort(input: {
  thinking: ThinkingConfig | undefined;
  executionMode?: string;
  byokModelId?: string;
  profileAlias?: string;
  modelAlias: string;
  gatewayConfigId?: string | null;
}): Promise<ThinkingConfig | undefined> {
  try {
    return await resolveChatThinkingWithDefaults({
      thinking: input.thinking,
      ...(input.executionMode ? { executionMode: input.executionMode } : {}),
      ...(input.byokModelId ? { byokModelId: input.byokModelId } : {}),
      ...(input.profileAlias ? { profileAlias: input.profileAlias } : {}),
      modelAlias: input.modelAlias,
      ...(input.gatewayConfigId
        ? { gatewayConfigId: input.gatewayConfigId }
        : {}),
    });
  } catch (error) {
    logger.warn(
      "Thinking-support fill failed; the caller's thinking rides unchanged",
      {
        modelAlias: input.modelAlias,
        profileAlias: input.profileAlias,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return input.thinking;
  }
}

/**
 * Fills the server-known thinking-support facts (synced onto the chat profile
 * by provider discovery) into a chat input whose caller expressed thinking
 * intent without them — see thinking-defaults.ts. Resolution happens here, at
 * the billed door every model call goes through, so a caller can say
 * `thinking: { enabled: false }` without also couriering catalog trivia.
 */
async function enrichChatThinking<T extends ChatCompleteInput>(
  chatInput: T,
  options: BilledRequestOptions,
): Promise<T> {
  const executionMode = chatInput.executionMode ?? options.llm?.executionMode;
  const profileAlias = chatInput.profileAlias ?? options.profileAlias;
  const byokModelId = chatInput.byokModelId ?? options.llm?.byokModelId;
  const thinking = await resolveThinkingBestEffort({
    thinking: chatInput.thinking,
    ...(executionMode ? { executionMode } : {}),
    ...(byokModelId ? { byokModelId } : {}),
    ...(profileAlias ? { profileAlias } : {}),
    modelAlias: options.modelAlias ?? chatInput.model,
    gatewayConfigId: options.gatewayConfigId,
  });
  return thinking === chatInput.thinking
    ? chatInput
    : { ...chatInput, thinking };
}

/**
 * Builds the request metadata the gateway forwards to its observe sink. This is
 * what lets the sink attribute a generation's cost, and it is derived from the
 * scope rather than accepted from the caller.
 */
function buildRequestMetadata(
  context: ModelUsageContext,
  billingOptions: ModelCallBillingOptions,
): Record<string, unknown> {
  return {
    teamId: context.teamId,
    workspaceId: context.workspaceId,
    userId: context.actorUserId,
    threadId: context.threadId,
    messageId: context.messageId,
    feature: context.feature,
    operation: billingOptions.operation,
    modelKind: billingOptions.modelKind,
    modelAlias: billingOptions.modelAlias ?? undefined,
    profileAlias: billingOptions.profileAlias,
    gatewayConfigId: billingOptions.gatewayConfigId,
    executionMode: billingOptions.llm?.executionMode,
  };
}

export type OpenBilledModelGatewayInput = {
  billing: ContentBillingPort;
  context: ModelUsageContext;
  gatewayConfigId?: string | null;
  /** Injected for tests; production uses the real metering funnel. */
  meterUsage?: MeterUsageFn;
};

/**
 * Opens a billing scope and returns it alongside the gateway, for callers that
 * cannot be expressed as a single callback — notably async generators, which
 * cannot yield across a callback boundary.
 *
 * Prefer {@link withBilledModelGateway} where a callback fits; it is this
 * function with the scope's lifetime bounded for you.
 */
export async function openBilledModelGateway(
  input: OpenBilledModelGatewayInput,
): Promise<{ gateway: BilledModelGateway; scope: BillingScope }> {
  return openBilledGateway(input);
}

export async function withBilledModelGateway<T>(
  input: OpenBilledModelGatewayInput,
  run: (gateway: BilledModelGateway, scope: BillingScope) => Promise<T>,
): Promise<T> {
  const { gateway, scope } = await openBilledGateway(input);
  return run(gateway, scope);
}

async function openBilledGateway(
  input: OpenBilledModelGatewayInput,
): Promise<{ gateway: BilledModelGateway; scope: BillingScope }> {
  // Admission gates spending, so it only applies to scopes that spend. A
  // covered scope deducts nothing by definition — refusing it because the team
  // is out of credits would withhold work the team is not being charged for.
  const decision =
    input.context.intent.mode === "covered"
      ? await admitCoveredScope(
          input.billing,
          input.context.teamId,
          input.context.actorUserId,
        )
      : await billingAdmission.admit({
          billing: input.billing,
          teamId: input.context.teamId,
          userId: input.context.actorUserId,
        });

  if (!decision.allowed) {
    throw new BillingAdmissionError(decision);
  }

  const scope = openBillingScope({
    context: input.context,
    billing: input.billing,
    billingMode: decision.billingMode,
    availableCredits: decision.availableCredits,
    meterUsage: input.meterUsage,
    scheduleReconciliation: enqueueProviderCostReconciliation,
  });

  const raw = await getRawModelGatewayClient(input.gatewayConfigId);

  async function settled<
    R extends {
      usage?: UsageInfo;
      observation?: ModelCallObservation;
    },
  >(
    options: BilledRequestOptions,
    call: (requestOptions: RequestOptions) => Promise<R>,
  ): Promise<R> {
    const { billingOptions, requestOptions } = splitOptions(options);
    const result = await call({
      ...requestOptions,
      metadata: buildRequestMetadata(input.context, billingOptions),
    });
    await scope.settle({
      options: billingOptions,
      usage: result.usage,
      observation: result.observation,
    });
    return result;
  }

  const gateway: BilledModelGateway = {
    chat: {
      complete: async (chatInput, options) => {
        const enriched = await enrichChatThinking(chatInput, options);
        return settled(options, (requestOptions) =>
          raw.chat.complete(enriched, requestOptions),
        );
      },
      stream: (chatInput, options) =>
        billedStream(raw, scope, input.context, chatInput, options),
    },
    embeddings: {
      embed: (embedInput, options) =>
        settled(options, (requestOptions) =>
          raw.embeddings.embed(embedInput, requestOptions),
        ),
      embedBatch: (embedInput, options) =>
        settled(options, (requestOptions) =>
          raw.embeddings.embedBatch(embedInput, requestOptions),
        ),
    },
    rerank: {
      rank: (rerankInput, options) =>
        settled(options, (requestOptions) =>
          raw.rerank.rank(rerankInput, requestOptions),
        ),
    },
    asr: {
      transcribe: (asrInput, options) =>
        settled(options, (requestOptions) =>
          raw.asr.transcribe(asrInput, requestOptions),
        ),
    },
    tts: {
      speech: (ttsInput, options) =>
        settled(options, (requestOptions) =>
          raw.tts.speech(ttsInput, requestOptions),
        ),
    },
    images: {
      generate: (imageInput, options) =>
        settled(options, (requestOptions) =>
          raw.images.generate(imageInput, requestOptions),
        ),
    },
    agentChatModel: async (agentInput) => {
      const execution = agentInput.execution;
      const thinking = await resolveThinkingBestEffort({
        thinking: execution?.thinking,
        ...(execution?.executionMode
          ? { executionMode: execution.executionMode }
          : {}),
        ...(execution?.byokModelId
          ? { byokModelId: execution.byokModelId }
          : {}),
        ...(execution?.profileAlias
          ? { profileAlias: execution.profileAlias }
          : {}),
        modelAlias: agentInput.modelAlias,
        gatewayConfigId: input.gatewayConfigId,
      });
      return createBilledAgentChatModel({
        modelAlias: agentInput.modelAlias,
        execution:
          thinking === execution?.thinking
            ? agentInput.execution
            : { ...execution, thinking },
        gatewayConfigId: input.gatewayConfigId,
        context: input.context,
        scope,
        billing: agentInput.billing,
      });
    },
  };

  return { gateway, scope };
}

/**
 * Wraps the stream so settlement happens exactly once, in a `finally`. A
 * consumer that breaks out early triggers the generator's `return()`, which
 * runs the `finally` — so abandoning a stream mid-flight no longer loses its
 * usage the way the previous accumulate/flush arrangement could.
 */
async function* billedStream(
  raw: ModelGateway,
  scope: BillingScope,
  context: ModelUsageContext,
  chatInput: ChatStreamInput,
  options: BilledRequestOptions,
): AsyncIterable<ChatStreamEvent> {
  const { billingOptions, requestOptions } = splitOptions(options);
  let usage: UsageInfo | undefined;
  let observation: ModelCallObservation | undefined;
  let settled = false;
  let inFlightError: unknown;

  const enrichedInput = await enrichChatThinking(chatInput, options);
  try {
    for await (const event of raw.chat.stream(enrichedInput, {
      ...requestOptions,
      metadata: buildRequestMetadata(context, billingOptions),
    })) {
      // Providers report cumulative usage, so the last report wins rather than
      // accumulating across chunks.
      if (event.type === "metadata" && event.metadata.usage) {
        usage = event.metadata.usage;
      }
      if (event.type === "metadata" && event.metadata.observation) {
        observation = event.metadata.observation;
      }
      yield event;
    }
  } catch (error) {
    inFlightError = error;
    throw error;
  } finally {
    if (!settled) {
      settled = true;
      try {
        await scope.settle({ options: billingOptions, usage, observation });
      } catch (settleError) {
        // Never let a settlement failure mask the error that ended the stream.
        if (!inFlightError) {
          throw settleError;
        }
      }
    }
  }
}
