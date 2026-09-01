import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type {
  LangChainModelExecutionConfig,
  ModelCallObservation,
  ObserveGenerationEnd,
  ObserveSink,
  UsageInfo,
} from "@sourceweft/model-gateway";
import { logger } from "../../logger";
import type { ModelCallBillingOptions, ModelUsageContext } from "./context";
import type { BillingScope } from "./scope";
import { createRawAgentChatModel } from "../internal/raw";

/**
 * Entry points through which the agent runtime can drive a chat model.
 *
 * The composing ones return new runnables, so they must re-proxy or billing
 * would be lost the moment the agent binds tools or requests structured output.
 */
/**
 * Methods that return a NEW runnable wrapping this model. Every one must
 * re-proxy, or billing is lost the moment the agent composes.
 *
 * `withConfig` and `bind` matter most: langchain@1.5's agent runtime calls
 * withConfig 34 times and deepagents calls bind 5 times, so treating them as
 * inert pass-throughs would let effectively every agent model call escape
 * unbilled while still looking wired up.
 */
const COMPOSING_ENTRY_POINTS = new Set([
  "bindTools",
  "withStructuredOutput",
  "pipe",
  "withConfig",
  "bind",
  "withRetry",
  "withFallbacks",
  "withListeners",
  "asTool",
]);

/** Methods that run the model and resolve to a single result. */
const INVOKING_ENTRY_POINTS = new Set([
  "invoke",
  "batch",
  "generate",
  "_generate",
]);

/**
 * Methods that run the model and return an async iterable. They settle when
 * iteration finishes, including on early abandonment.
 *
 * Because pass-through reads bind to the raw model, a nested call such as
 * streamEvents → this.stream() reaches the unproxied target, so each of these
 * must bill for itself rather than relying on `stream` to catch it. That same
 * binding is what stops it from double-billing.
 */
const STREAMING_ENTRY_POINTS = new Set([
  "stream",
  "streamEvents",
  "streamLog",
  "transform",
]);

const warnedUnknownEntryPoints = new Set<string>();

type UsageSlot = {
  usage?: UsageInfo;
  observation?: ModelCallObservation;
};

/**
 * One capture slot per in-flight model call.
 *
 * A single shared slot is not enough: the agent runtime can drive one model
 * concurrently, and a call reports its usage before it finishes resolving, so
 * two overlapping calls would otherwise settle against whichever usage was
 * written last. Async context binds each report to the call that caused it.
 */
const usageStorage = new AsyncLocalStorage<UsageSlot>();

/**
 * Per-model observe sink used purely as a usage transport.
 *
 * Safe here — and only here — because `createRawAgentChatModel` builds a fresh
 * gateway config per invocation rather than reusing the process-wide cached
 * client, so this cannot leak one team's usage into another's. The sink carries
 * no control: it only fills the current call's slot, and the proxy decides.
 */
function createUsageCaptureSink(): ObserveSink {
  return {
    onGenerationEnd(generation: ObserveGenerationEnd) {
      if (!generation.usage) {
        return;
      }
      const slot = usageStorage.getStore();
      if (slot) {
        slot.usage = generation.usage;
        slot.observation = generation.observation;
      }
    },
  };
}

export async function createBilledAgentChatModel(input: {
  modelAlias: string;
  execution?: LangChainModelExecutionConfig;
  gatewayConfigId?: string | null;
  context: ModelUsageContext;
  scope: BillingScope;
  billing: Omit<ModelCallBillingOptions, "operation">;
}): Promise<BaseLanguageModel> {
  const model = await createRawAgentChatModel({
    modelAlias: input.modelAlias,
    gatewayConfigId: input.gatewayConfigId,
    execution: {
      ...input.execution,
      metadata: {
        ...(input.execution?.metadata ?? {}),
        teamId: input.context.teamId,
        workspaceId: input.context.workspaceId,
        userId: input.context.actorUserId,
        threadId: input.context.threadId,
        messageId: input.context.messageId,
        feature: input.context.feature,
        modelKind: input.billing.modelKind,
        profileAlias: input.billing.profileAlias,
        gatewayConfigId: input.billing.gatewayConfigId,
      },
    },
    observeSink: createUsageCaptureSink(),
  });

  return wrapBilledModel(model, input.scope, input.billing);
}

function wrapBilledModel<T extends object>(
  model: T,
  scope: BillingScope,
  billing: Omit<ModelCallBillingOptions, "operation">,
): T {
  async function settleAfter(operation: string, run: () => Promise<unknown>) {
    const slot: UsageSlot = {};
    const result = await usageStorage.run(slot, run);
    await scope.settle({
      options: { ...billing, operation },
      usage: slot.usage,
      observation: slot.observation,
    });
    return result;
  }

  return new Proxy(model, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);

      if (typeof prop !== "string" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      if (COMPOSING_ENTRY_POINTS.has(prop)) {
        return (...args: unknown[]) => {
          const composed = value.apply(target, args) as object;
          return composed && typeof composed === "object"
            ? wrapBilledModel(composed, scope, billing)
            : composed;
        };
      }

      if (INVOKING_ENTRY_POINTS.has(prop)) {
        return (...args: unknown[]) =>
          settleAfter(`chat.${prop}`, () =>
            Promise.resolve(value.apply(target, args)),
          );
      }

      if (STREAMING_ENTRY_POINTS.has(prop)) {
        return async (...args: unknown[]) => {
          const slot: UsageSlot = {};
          const stream = (await usageStorage.run(slot, async () =>
            value.apply(target, args),
          )) as AsyncIterable<unknown>;
          return billedModelStream(
            stream,
            slot,
            scope,
            billing,
            `chat.${prop}`,
          );
        };
      }

      // Anything else passes through unbilled. Warned once per method so a
      // LangChain upgrade that introduces a new way to drive the model shows up
      // as a log line rather than silent lost revenue.
      if (
        !warnedUnknownEntryPoints.has(prop) &&
        !IGNORED_ENTRY_POINTS.has(prop)
      ) {
        warnedUnknownEntryPoints.add(prop);
        logger.debug("Unbilled LangChain model method invoked", {
          method: prop,
        });
      }
      return value.bind(target);
    },
  }) as T;
}

/**
 * Introspection and serialisation only — these neither run the model nor
 * produce a new runnable. Listing them keeps the warning above signal rather
 * than noise. Anything that is neither here nor in a handled set is warned
 * about precisely because an unclassified method may be a way to run the model.
 */
const IGNORED_ENTRY_POINTS = new Set([
  "getName",
  "toString",
  "toJSON",
  "toJSONNotImplemented",
  "then",
  "constructor",
  "_modelType",
  "_llmType",
  "_identifyingParams",
  "getLsParams",
  "getNumTokens",
  "getNumTokensFromMessages",
  "serialize",
  "lc_id",
  "lc_secrets",
  "lc_attributes",
  "lc_namespace",
  "lc_serializable",
  "lc_kwargs",
]);

async function* billedModelStream(
  stream: AsyncIterable<unknown>,
  slot: UsageSlot,
  scope: BillingScope,
  billing: Omit<ModelCallBillingOptions, "operation">,
  operation: string,
) {
  let inFlightError: unknown;
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      // Each resumption is driven from the consumer's async context, so the
      // slot has to be re-entered per step for usage reported mid-stream to
      // land on this call rather than whatever else is in flight.
      const next = await usageStorage.run(slot, () => iterator.next());
      if (next.done) {
        break;
      }
      yield next.value;
    }
  } catch (error) {
    inFlightError = error;
    throw error;
  } finally {
    await iterator.return?.();
    try {
      await scope.settle({
        options: { ...billing, operation },
        usage: slot.usage,
        observation: slot.observation,
      });
    } catch (settleError) {
      if (!inFlightError) {
        throw settleError;
      }
    }
  }
}
