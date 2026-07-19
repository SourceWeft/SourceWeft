import type { UsageInfo } from "@sourceweft/model-gateway";
import type { LlmExecutionConfig } from "../../../modules/content/model-gateway-audit";
import type { ModelProfileKind } from "../../../modules/content/types";

/**
 * Why a model call is not charged to the customer.
 *
 * Declaring one is the only way to make a model call without billing it, which
 * turns "this is free" from an omission into a greppable, reviewable decision.
 */
export type CoveredReason =
  /** Retrieval embeddings and rerank. Cost is recorded, not charged. */
  | "model_kind_not_user_billed"
  /** Ingestion vision extraction, already charged per ingested page. */
  | "covered_by_ingestion_page"
  /** Customer supplied their own provider key, so there is no cost to pass on. */
  | "byok";

export type BillingIntent =
  | { readonly mode: "billed" }
  | { readonly mode: "covered"; readonly coveredBy: CoveredReason };

/**
 * Identity and tenancy for everything a scope bills. The wrapper synthesises
 * per-request metadata from this, so a call site cannot report a different team
 * than the one it opened the scope for.
 */
export type ModelUsageContext = {
  readonly teamId: string;
  readonly workspaceId?: string;
  readonly actorUserId: string;
  readonly feature: string;
  readonly intent: BillingIntent;
  /**
   * Idempotency root: the turn's traceId, the worker's jobId, or the API
   * request id. Derived per-call keys hang off this, so replaying the same
   * scope replays the same keys and cannot double-charge.
   */
  readonly scopeKind: "thread-turn" | "worker-job" | "api-request";
  readonly scopeId: string;
  readonly threadId?: string;
  readonly messageId?: string;
};

/** Per-call billing identity. `metadata` is deliberately absent — see BilledRequestOptions. */
export type ModelCallBillingOptions = {
  operation: string;
  modelKind: ModelProfileKind;
  profileAlias: string;
  modelAlias?: string | null;
  gatewayConfigId: string;
  llm?: LlmExecutionConfig;
  /**
   * Pins the idempotency key. Every migrated call site must pass the key it
   * used before the migration: changing a key on an already-metered reference
   * charges the customer a second time.
   */
  idempotencyKey?: string;
  /** Disambiguates the derived-key counter when one scope makes many like calls. */
  scopeKey?: string | number;
  referenceId?: string;
  billingMetadata?: Record<string, unknown>;
};

export type MeteredModelCallTrace = {
  id: string;
  operation: string;
  modelKind: ModelProfileKind;
  modelAlias: string | null;
  profileAlias: string | null;
  gatewayConfigId: string;
  usage?: UsageInfo;
  billingStatus: "metered" | "skipped" | "covered" | "meter_failed";
  consumedCredits: number;
  billedBy?: "provider_cost" | "minimum_credit" | "skipped";
  skipReason?: string | null;
  coveredBy?: CoveredReason;
  idempotencyKey: string;
  referenceId: string;
  providerCostUsd?: number | null;
  costSource?: string;
  missingPriceComponents?: string[];
  pricingSnapshot?: unknown;
  billing?: {
    teamId: string;
    availableCredits: number;
    consumedThisCycle: number;
    idempotencyReplayed: boolean;
  };
  error?: string;
  metadata?: Record<string, unknown>;
};
