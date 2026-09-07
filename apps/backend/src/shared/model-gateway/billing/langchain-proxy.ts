import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { LangChainModelExecutionConfig } from "@sourceweft/model-gateway";
import { logger } from "../../logger";
import type { ModelCallBillingOptions, ModelUsageContext } from "./context";
import type { BillingScope } from "./scope";
import { createRawAgentChatModel } from "../internal/raw";
import {
  createUsageCaptureSink,
  usageStorage,
  type UsageSlot,
} from "./usage-capture";

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
    let failed = false;
    try {
      return await usageStorage.run(slot, run);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await scope.settle({
          options: { ...billing, operation },
          usage: slot.usage,
          observation: slot.observation,
        });
      } catch (error) {
        if (!failed) throw error;
        logger.warn("Settlement failed after model error", { operation });
      }
    }
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
          let stream: AsyncIterable<unknown>;
          try {
            stream = await usageStorage.run(slot, async () =>
              value.apply(target, args),
            );
            return billedModelStream(
              stream,
              slot,
              scope,
              billing,
              `chat.${prop}`,
            );
          } catch (error) {
            try {
              await scope.settle({
                options: { ...billing, operation: `chat.${prop}` },
                usage: slot.usage,
                observation: slot.observation,
              });
            } catch {
              logger.warn("Settlement failed after stream creation error", {
                operation: `chat.${prop}`,
              });
            }
            throw error;
          }
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

function billedModelStream(
  stream: AsyncIterable<unknown>,
  slot: UsageSlot,
  scope: BillingScope,
  billing: Omit<ModelCallBillingOptions, "operation">,
  operation: string,
): AsyncIterableIterator<unknown> {
  const iterator = usageStorage.run(slot, () => stream[Symbol.asyncIterator]());
  let failed = false;
  let finalization: Promise<void> | undefined;
  const finish = () =>
    (finalization ??= (async () => {
      let closeFailed = false;
      let closeError: unknown;
      try {
        if (iterator.return)
          await usageStorage.run(slot, () => iterator.return!());
      } catch (error) {
        closeFailed = true;
        closeError = error;
      }
      try {
        await scope.settle({
          options: { ...billing, operation },
          usage: slot.usage,
          observation: slot.observation,
        });
      } catch (error) {
        if (!failed && !closeFailed) throw error;
        logger.warn("Settlement failed while closing model stream", {
          operation,
        });
      }
      if (closeFailed && !failed) throw closeError;
    })());
  const consume = (async function* () {
    try {
      while (true) {
        const next = await usageStorage.run(slot, () => iterator.next());
        if (next.done) return;
        yield next.value;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await finish();
    }
  })();
  // The upstream stream is already open. Async-generator return before first
  // next skips its body/finally, so its owner must finalize that path explicitly.
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: (value) => consume.next(value),
    async return(value) {
      try {
        return await consume.return(value);
      } finally {
        await finish();
      }
    },
    async throw(error) {
      failed = true;
      try {
        return await consume.throw(error);
      } finally {
        await finish();
      }
    },
  };
}
