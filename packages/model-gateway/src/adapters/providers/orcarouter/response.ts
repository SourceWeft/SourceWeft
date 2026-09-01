import type {
  ModelCallObservationPatch,
  ProviderResponseContext,
} from "../../../observation/types";
import { finiteNumber } from "../../../normalize/protocols/openai-compatible";

export const ORCAROUTER_RESPONSE_HEADERS = [
  "x-orca-request-id",
  "x-orca-resolved-model",
  "x-orca-router",
  "x-orca-fallback-level",
  "x-orca-fallback-model",
] as const;

export function selectOrcaRouterResponseHeaders(
  headers: Headers,
): Record<string, string> {
  return Object.fromEntries(
    ORCAROUTER_RESPONSE_HEADERS.flatMap((name) => {
      const value = headers.get(name);
      return value ? [[name, value] as const] : [];
    }),
  );
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function normalizeOrcaRouterResponse(
  context: ProviderResponseContext,
): ModelCallObservationPatch | undefined {
  const selectedHeaders = context.selectedResponseHeaders ?? {};
  const resolvedModel =
    selectedHeaders["x-orca-resolved-model"] ??
    metadataString(context.responseMetadata, "model_name") ??
    metadataString(context.responseMetadata, "model");
  const requestId = selectedHeaders["x-orca-request-id"];
  const routerName = selectedHeaders["x-orca-router"];
  const fallbackModel = selectedHeaders["x-orca-fallback-model"];
  const rawFallbackLevel = selectedHeaders["x-orca-fallback-level"];
  const fallbackLevel =
    rawFallbackLevel === undefined ? undefined : Number(rawFallbackLevel);
  const costUsd = finiteNumber(context.rawUsage?.cost_usd);

  if (
    !resolvedModel &&
    !requestId &&
    !routerName &&
    !fallbackModel &&
    costUsd === undefined
  ) {
    return undefined;
  }

  return {
    identity: {
      ...(resolvedModel ? { resolvedProviderModel: resolvedModel } : {}),
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(routerName ? { routerName } : {}),
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(fallbackLevel !== undefined && Number.isFinite(fallbackLevel)
        ? { fallbackLevel }
        : {}),
    },
    cost:
      costUsd !== undefined
        ? {
            currency: "USD" as const,
            inlineUsd: costUsd,
            effectiveUsd: costUsd,
            source: "provider_inline" as const,
            status: "inline" as const,
          }
        : {
            currency: "USD" as const,
            source: "missing" as const,
            status: requestId ? ("pending" as const) : ("missing" as const),
          },
    provenance: {
      ...(resolvedModel
        ? {
            resolvedModel: selectedHeaders["x-orca-resolved-model"]
              ? "provider:orcarouter.header.x-orca-resolved-model"
              : "provider:orcarouter.response_metadata.model_name",
          }
        : {}),
      ...(costUsd !== undefined
        ? { inlineCost: "provider:orcarouter.usage.cost_usd" }
        : {}),
    },
  };
}
