import type { ResolvedRequestTarget, UsageInfo } from "../types";

export type ModelCallCostSource =
  | "provider_inline"
  | "provider_receipt"
  | "provider_estimated"
  | "price_book"
  | "temporary_minimum"
  | "legacy"
  | "missing";

export type ModelCallCostStatus =
  | "pending"
  | "inline"
  | "settled"
  | "estimated"
  | "legacy"
  | "missing"
  | "reconcile_failed";

export interface ModelCallIdentity {
  modelAlias: string;
  provider: string;
  requestedProviderModel: string;
  resolvedProviderModel?: string;
  providerRequestId?: string;
  routerName?: string;
  fallbackModel?: string;
  fallbackLevel?: number;
}

export interface ModelCallCost {
  currency: "USD";
  inlineUsd?: number;
  settledUsd?: number;
  effectiveUsd?: number;
  source: ModelCallCostSource;
  status: ModelCallCostStatus;
}

export interface ModelCallProvenance {
  usage?: string;
  resolvedModel?: string;
  inlineCost?: string;
  settledCost?: string;
}

export interface ModelCallDiagnostic {
  code: string;
  field?: string;
  message: string;
}

export interface ModelCallObservation {
  traceId?: string;
  spanId?: string;
  identity: ModelCallIdentity;
  usage?: UsageInfo;
  cost?: ModelCallCost;
  provenance: ModelCallProvenance;
  diagnostics?: ModelCallDiagnostic[];
  providerResponseHeaders?: Record<string, string>;
}

export type ModelCallObservationPatch = {
  identity?: Partial<ModelCallIdentity>;
  usage?: UsageInfo;
  cost?: ModelCallCost;
  provenance?: Partial<ModelCallProvenance>;
  diagnostics?: ModelCallDiagnostic[];
  providerResponseHeaders?: Record<string, string>;
};

export type ModelProfileModality =
  | "chat"
  | "embedding"
  | "rerank"
  | "asr"
  | "tts"
  | "image"
  | "vision"
  | "video";

export interface ProviderResponseContext {
  target: ResolvedRequestTarget;
  modality: ModelProfileModality;
  rawResponse?: unknown;
  rawUsage?: Record<string, unknown>;
  sdkUsage?: unknown;
  responseMetadata?: Record<string, unknown>;
  responseHeaders?: Headers;
  selectedResponseHeaders?: Record<string, string>;
}

export interface ProviderRequestContext {
  target: ResolvedRequestTarget;
  modality: ModelProfileModality;
  stream: boolean;
  extraBody?: Record<string, unknown>;
}

export interface ProviderRequestPatch {
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface ProviderReceiptContext {
  baseUrl: string;
  apiKey?: string;
  requestId: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface ProviderReceipt {
  resolvedProviderModel?: string;
  usage?: UsageInfo;
  settledCostUsd: number;
  currency: "USD";
  raw: Record<string, unknown>;
}

export interface ProviderResponseAdapter {
  decorateRequest?(
    context: ProviderRequestContext,
  ): ProviderRequestPatch | undefined;
  selectResponseHeaders?(headers: Headers): Record<string, string>;
  normalizeResponse?(
    context: ProviderResponseContext,
    base: ModelCallObservation,
  ): ModelCallObservationPatch | undefined;
  reconcileCost?(context: ProviderReceiptContext): Promise<ProviderReceipt>;
  costCapabilities?: {
    actualCostMode: "none" | "inline" | "receipt" | "inline_and_receipt";
    allowPriceBookFallback: boolean;
  };
}
