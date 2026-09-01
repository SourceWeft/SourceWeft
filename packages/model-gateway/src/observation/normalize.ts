import { getProviderResponseAdapter } from "../adapters/providers/registry";
import { extractRawUsage } from "../normalize/extract";
import {
  finiteNumber,
  isRecord,
  normalizeOpenAICompatibleUsage,
} from "../normalize/protocols/openai-compatible";
import type { UsageInfo } from "../types";
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

function finalizeUsage(
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
  ] as const) {
    sanitizeTokenField(finalized, field, diagnostics);
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

function normalizedSdkUsage(input: unknown) {
  if (!isRecord(input)) {
    return undefined;
  }
  return normalizeOpenAICompatibleUsage(input);
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

function mirrorCostForCompatibility(observation: ModelCallObservation) {
  const costUsd = observation.cost?.effectiveUsd;
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
    return observation;
  }
  observation.usage = {
    ...(observation.usage ?? {}),
    providerCostUsd: costUsd,
    providerCostSource:
      observation.cost?.source === "provider_estimated"
        ? "provider_estimated"
        : "provider_inline",
    ...(observation.provenance.inlineCost
      ? { providerCostSourcePath: observation.provenance.inlineCost }
      : {}),
  };
  return observation;
}

export function normalizeModelCallObservation(input: {
  context: Omit<ProviderResponseContext, "rawUsage">;
  modelAlias: string;
}): ModelCallObservation {
  const rawUsage = extractRawUsage(input.context.rawResponse);
  const protocolUsage =
    normalizeOpenAICompatibleUsage(rawUsage) ??
    normalizedSdkUsage(input.context.sdkUsage);
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
  return mirrorCostForCompatibility(merged);
}
