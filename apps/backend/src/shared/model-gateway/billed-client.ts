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
      complete: (chatInput, options) =>
        settled(options, (requestOptions) =>
          raw.chat.complete(chatInput, requestOptions),
        ),
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
    agentChatModel: (agentInput) =>
      createBilledAgentChatModel({
        modelAlias: agentInput.modelAlias,
        execution: agentInput.execution,
        gatewayConfigId: input.gatewayConfigId,
        context: input.context,
        scope,
        billing: agentInput.billing,
      }),
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

  try {
    for await (const event of raw.chat.stream(chatInput, {
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
