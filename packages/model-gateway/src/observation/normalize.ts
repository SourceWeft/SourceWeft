import { getProviderResponseAdapter } from "../adapters/providers/registry";
import { extractRawUsage } from "../normalize/extract";
import {
  detailsNumber,
  finiteNumber,
  isRecord,
  normalizeOpenAICompatibleUsage,
} from "../normalize/protocols/openai-compatible";
import type { ResolvedRequestTarget, UsageInfo } from "../types";
import type {
  ModelCallDiagnostic,
  ModelCallObservation,
  ModelCallObservationPatch,
  ProviderResponseContext,
} from "./types";

function compactUsage(usage: UsageInfo | undefined): UsageInfo | undefined {
  if (!usage) {
    return undefined;
  }
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

function mergeUsage(base: UsageInfo | undefined, patch: UsageInfo | undefined) {
  return compactUsage({ ...(base ?? {}), ...(patch ?? {}) });
}

function sanitizeTokenField(
  usage: UsageInfo,
  field: keyof UsageInfo,
  diagnostics: ModelCallDiagnostic[],
) {
  const value = usage[field];
  if (value === undefined || typeof value !== "number") {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    delete (usage as Record<string, unknown>)[field];
    diagnostics.push({
      code: "INVALID_USAGE_FIELD",
      field,
      message: `Discarded invalid ${field} value '${String(value)}'`,
    });
  }
}

export function finalizeUsage(
  usage: UsageInfo | undefined,
  diagnostics: ModelCallDiagnostic[],
) {
  const finalized = compactUsage(usage);
  if (!finalized) {
    return undefined;
  }
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "inputImageTokens",
    "outputImageTokens",
    "inputImageCount",
    "outputImageCount",
    "inputAudioTokens",
    "outputAudioTokens",
    "inputCharacters",
  ] as const) {
    sanitizeTokenField(finalized, field, diagnostics);
  }
  // A duration, not a count: any non-negative finite number is valid.
  const seconds = finalized.inputAudioSeconds;
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0)) {
    delete finalized.inputAudioSeconds;
    diagnostics.push({
      code: "INVALID_USAGE_FIELD",
      field: "inputAudioSeconds",
      message: `Discarded invalid inputAudioSeconds value '${String(seconds)}'`,
    });
  }

  if (
    finalized.totalTokens === undefined &&
    finalized.inputTokens !== undefined &&
    finalized.outputTokens !== undefined
  ) {
    finalized.totalTokens = finalized.inputTokens + finalized.outputTokens;
  }
  if (
    finalized.reasoningTokens !== undefined &&
    finalized.outputTokens !== undefined &&
    finalized.reasoningTokens > finalized.outputTokens
  ) {
    diagnostics.push({
      code: "USAGE_BOUND_EXCEEDED",
      field: "reasoningTokens",
      message: "reasoningTokens exceeded outputTokens",
    });
  }
  const cacheTokens =
    (finalized.cacheReadTokens ?? 0) + (finalized.cacheWriteTokens ?? 0);
  if (
    finalized.inputTokens !== undefined &&
    cacheTokens > finalized.inputTokens
  ) {
    diagnostics.push({
      code: "USAGE_BOUND_EXCEEDED",
      field: "cacheReadTokens",
      message: "cache read/write tokens exceeded inputTokens",
    });
  }
  return compactUsage(finalized);
}

/**
 * Anthropic's own usage object cannot be read like an OpenAI-compatible one.
 * Its `input_tokens` leaves out the tokens read from and written to the prompt
 * cache, where `UsageInfo.inputTokens` includes them. A streamed reply also
 * splits it between `message_start` and `message_delta`, so the last chunk and
 * the last usage object on the wire each hold only part of it. LangChain merges
 * the two events and adds the cache tokens to the input count, so its
 * `usage_metadata` is the one complete figure for the call.
 */
function reportsUsageThroughLangChain(target: ResolvedRequestTarget) {
  return target.providerKind === "anthropic";
}

/**
 * Usage as the SDK reports it. That is LangChain's `usage_metadata` when the
 * message has one, which names the cached and reasoning tokens `cache_read`,
 * `cache_creation` and `reasoning` where a provider's own usage object says
 * `cached_tokens` and `reasoning_tokens`. A reply with no provider usage
 * object to read (a non-streamed Responses API reply) has only this.
 */
function normalizeLangChainUsage(input: unknown): UsageInfo | undefined {
  const usage = normalizeOpenAICompatibleUsage(input);
  if (!usage || !isRecord(input)) {
    return usage;
  }
  const inputDetails = input.input_token_details;
  const reasoningTokens =
    detailsNumber(input.output_token_details, "reasoning") ??
    usage.reasoningTokens;
  return {
    ...usage,
    cacheReadTokens:
      detailsNumber(inputDetails, "cache_read") ?? usage.cacheReadTokens,
    cacheWriteTokens:
      detailsNumber(inputDetails, "cache_creation") ?? usage.cacheWriteTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function mergeObservation(
  base: ModelCallObservation,
  patch: ModelCallObservationPatch | undefined,
): ModelCallObservation {
  if (!patch) {
    return base;
  }
  return {
    identity: { ...base.identity, ...(patch.identity ?? {}) },
    usage: mergeUsage(base.usage, patch.usage),
    cost: patch.cost ?? base.cost,
    provenance: { ...base.provenance, ...(patch.provenance ?? {}) },
    diagnostics: [...(base.diagnostics ?? []), ...(patch.diagnostics ?? [])],
    providerResponseHeaders:
      patch.providerResponseHeaders ?? base.providerResponseHeaders,
  };
}

export function mergeModelCallObservations(
  current: ModelCallObservation | undefined,
  next: ModelCallObservation,
): ModelCallObservation {
  if (!current) {
    return next;
  }
  const diagnostics = [
    ...(current.diagnostics ?? []),
    ...(next.diagnostics ?? []),
  ];
  return {
    traceId: next.traceId ?? current.traceId,
    spanId: next.spanId ?? current.spanId,
    identity: { ...current.identity, ...next.identity },
    usage: next.usage ?? current.usage,
    cost: next.cost ?? current.cost,
    provenance: { ...current.provenance, ...next.provenance },
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    providerResponseHeaders:
      next.providerResponseHeaders ?? current.providerResponseHeaders,
  };
}

export function normalizeModelCallObservation(input: {
  context: Omit<ProviderResponseContext, "rawUsage">;
  modelAlias: string;
}): ModelCallObservation {
  const sdkOnly = reportsUsageThroughLangChain(input.context.target);
  const rawUsage = sdkOnly
    ? undefined
    : (extractRawUsage(input.context.rawResponse) ??
      input.context.capturedUsage);
  const protocolUsage = sdkOnly
    ? normalizeLangChainUsage(input.context.sdkUsage)
    : (normalizeOpenAICompatibleUsage(rawUsage) ??
      normalizeLangChainUsage(input.context.sdkUsage));
  const base: ModelCallObservation = {
    identity: {
      modelAlias: input.modelAlias,
      provider: input.context.target.provider,
      requestedProviderModel: input.context.target.providerModel,
    },
    usage: protocolUsage,
    provenance: {
      ...(protocolUsage
        ? {
            usage: rawUsage
              ? "protocol:openai-compatible.raw_usage"
              : "protocol:langchain.sdk_usage",
          }
        : {}),
    },
  };
  const providerAdapter = getProviderResponseAdapter(
    input.context.target.provider,
  );
  const selectedHeaders =
    input.context.responseHeaders && providerAdapter?.selectResponseHeaders
      ? providerAdapter.selectResponseHeaders(input.context.responseHeaders)
      : undefined;
  const context: ProviderResponseContext = {
    ...input.context,
    rawUsage,
    selectedResponseHeaders: selectedHeaders,
  };
  const patch = providerAdapter?.normalizeResponse?.(context, base);
  const merged = mergeObservation(base, {
    ...patch,
    ...(selectedHeaders && Object.keys(selectedHeaders).length > 0
      ? { providerResponseHeaders: selectedHeaders }
      : {}),
  });
  const diagnostics = [...(merged.diagnostics ?? [])];
  merged.usage = finalizeUsage(merged.usage, diagnostics);
  if (
    merged.cost?.effectiveUsd !== undefined &&
    (finiteNumber(merged.cost.effectiveUsd) === undefined ||
      merged.cost.effectiveUsd < 0)
  ) {
    diagnostics.push({
      code: "INVALID_PROVIDER_COST",
      field: "effectiveUsd",
      message: "Discarded invalid provider cost",
    });
    merged.cost = undefined;
  }
  merged.diagnostics = diagnostics.length > 0 ? diagnostics : undefined;
  return merged;
}
