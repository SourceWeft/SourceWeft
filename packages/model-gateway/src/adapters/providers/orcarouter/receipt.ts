import type {
  ProviderReceipt,
  ProviderReceiptContext,
} from "../../../observation/types";
import {
  finiteNumber,
  isRecord,
} from "../../../normalize/protocols/openai-compatible";

export class ProviderReceiptPendingError extends Error {
  readonly code = "PROVIDER_RECEIPT_PENDING";
}

export async function reconcileOrcaRouterCost(
  context: ProviderReceiptContext,
): Promise<ProviderReceipt> {
  const url = new URL("generation", `${context.baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("id", context.requestId);
  const response = await context.fetch(url, {
    headers: context.apiKey
      ? { Authorization: `Bearer ${context.apiKey}` }
      : undefined,
    signal: context.signal,
  });
  if (response.status === 404) {
    throw new ProviderReceiptPendingError(
      `Provider receipt '${context.requestId}' is not settled yet`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to load OrcaRouter receipt '${context.requestId}': ${response.status}`,
    );
  }

  const raw = await response.json();
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error("OrcaRouter receipt response did not contain data");
  }
  const data = raw.data;
  const settledCostUsd = finiteNumber(data.total_cost);
  if (settledCostUsd === undefined || settledCostUsd < 0) {
    throw new Error("OrcaRouter receipt did not contain a valid total_cost");
  }
  const inputTokens = finiteNumber(data.tokens_prompt);
  const outputTokens = finiteNumber(data.tokens_completion);
  const totalTokens =
    finiteNumber(data.tokens_total) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const resolvedProviderModel =
    typeof data.model === "string" ? data.model.trim() || undefined : undefined;
  const currency =
    typeof data.cost_currency === "string"
      ? data.cost_currency.trim().toUpperCase()
      : "USD";
  if (currency !== "USD") {
    throw new Error(`Unsupported OrcaRouter receipt currency '${currency}'`);
  }

  return {
    resolvedProviderModel,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
    },
    settledCostUsd,
    currency: "USD",
    raw,
  };
}
