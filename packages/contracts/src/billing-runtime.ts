import type {
  BillingMode,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
} from "./billing";

/** Billing never resolves authorization or provider credentials for the host. */
export type BillingActor = {
  teamId: string;
  actorUserId: string;
  workspaceId?: string;
};

export type BillingExecutionState =
  | { kind: "unmetered"; reason: "billing_not_installed" }
  | {
      kind: "metered";
      mode: BillingMode;
      availableCredits: number;
      consumedThisCycle: number;
    };

export type BillingSkipped = {
  status: "skipped";
  reason: "billing_not_installed" | "byok" | "model_kind_not_user_billed";
};

/** Observed cost facts, supplied by the host's existing provider-cost reader. */
export type BillingModelCost = {
  providerCostUsd: number | null;
  costSource: string;
  missingPriceComponents: string[];
  pricingSnapshot: unknown;
};

export type SettleModelUsageInput = BillingActor & {
  feature: string;
  operation: string;
  modelKind: string;
  profileAlias: string;
  modelAlias?: string | null;
  referenceId?: string;
  idempotencyKey?: string;
  executionMode?: "GLOBAL" | "BYOK";
  cost: BillingModelCost;
  providerActualCostUsd?: number | null;
  providerCostSource?: string | null;
  providerCostDetails?: unknown;
  metadata?: Record<string, unknown>;
};

export type ModelSettlement =
  | BillingSkipped
  | {
      status: "settled";
      billedBy: "provider_cost" | "minimum_credit";
      billing: MeterConsumeResponse;
    };

export type IngestionSettlement =
  BillingSkipped | { status: "settled"; billing: MeterIngestionResponse };

export type ReconcileBillingProviderCostInput = BillingActor & {
  feature: string;
  originalIdempotencyKey: string;
  reconciliationIdempotencyKey: string;
  generationId: string;
  provider: string;
  providerRequestId: string;
  settledProviderCostUsd: number;
};

/** No checkout, plan catalog, account rows or payment SDK in the execution port. */
export interface BillingRuntime {
  getExecutionState(
    teamId: string,
    actorUserId: string,
  ): Promise<BillingExecutionState>;
  settleModelUsage(input: SettleModelUsageInput): Promise<ModelSettlement>;
  meterIngestion(
    teamId: string,
    input: MeterIngestionRequest,
    actorUserId: string,
  ): Promise<IngestionSettlement>;
  reconcileProviderCost(
    input: ReconcileBillingProviderCostInput,
  ): Promise<
    | BillingSkipped
    | {
        status: "settled";
        adjustedCredits: number;
        idempotencyReplayed: boolean;
      }
  >;
}

export interface BillingOrganizationHooks {
  provisionAccount(teamId: string, userId: string): Promise<void>;
  beforeAddMember(teamId: string): Promise<void>;
  beforeInviteMember(teamId: string): Promise<void>;
  beforeAcceptInvitation(teamId: string): Promise<void>;
}

/** Stable across separately bundled core/commercial code. */
export class BillingError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isBillingError(error: unknown): error is BillingError {
  if (typeof error !== "object" || error === null) return false;
  const value = error as Record<string, unknown>;
  return (
    value.name === "BillingError" &&
    typeof value.message === "string" &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.statusCode === "number" &&
    Number.isInteger(value.statusCode) &&
    value.statusCode >= 400 &&
    value.statusCode <= 599 &&
    (value.details === undefined ||
      (typeof value.details === "object" &&
        value.details !== null &&
        !Array.isArray(value.details)))
  );
}
