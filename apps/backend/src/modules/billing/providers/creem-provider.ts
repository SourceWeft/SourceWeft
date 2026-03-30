import {
  cancelSubscription,
  createCheckout,
  createPortal,
} from "@creem_io/better-auth/server";
import type { BillingSubscriptionStatus } from "@polyer/contracts";
import type { BillingRuntimeConfig } from "../types";
import type {
  BillingProviderAdapter,
  BillingProviderCancelInput,
  BillingProviderCancelResult,
  BillingProviderCheckoutInput,
  BillingProviderCheckoutResult,
  BillingProviderPortalInput,
  BillingProviderPortalResult,
} from "../types";
import { BillingError } from "../errors";

type CreemServerOptions = {
  apiKey: string;
  testMode?: boolean;
};

function pickString(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  return null;
}

function pickBoolean(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  return null;
}

function pickSubscriptionStatus(
  value: unknown,
): BillingSubscriptionStatus | null {
  const status = pickString(value, ["status", "subscriptionStatus"]);
  if (!status) {
    return null;
  }

  const normalized = status.trim().toLowerCase();
  const allowed = new Set<BillingSubscriptionStatus>([
    "inactive",
    "trialing",
    "active",
    "past_due",
    "paused",
    "unpaid",
    "canceled",
    "expired",
  ]);

  return allowed.has(normalized as BillingSubscriptionStatus)
    ? (normalized as BillingSubscriptionStatus)
    : null;
}

export class CreemBillingProvider implements BillingProviderAdapter {
  private readonly options: CreemServerOptions;
  private readonly teamStandardProductId: string;
  private readonly defaultSuccessUrl: string;

  constructor(config: BillingRuntimeConfig) {
    this.options = {
      apiKey: config.creem.apiKey,
      testMode: config.creem.testMode,
    };
    this.teamStandardProductId = config.creem.teamStandardProductId;
    this.defaultSuccessUrl = config.creem.defaultSuccessUrl;

    if (!this.options.apiKey) {
      throw new BillingError(
        "CREEM_API_KEY_MISSING",
        500,
        "CREEM_API_KEY is required when BACKEND_BILLING_PROVIDER=creem",
      );
    }

    if (!this.teamStandardProductId) {
      throw new BillingError(
        "CREEM_PRODUCT_ID_MISSING",
        500,
        "CREEM_TEAM_STANDARD_PRODUCT_ID is required for team subscriptions",
      );
    }
  }

  async createCheckout(
    input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutResult> {
    const successUrl = input.successUrl || this.defaultSuccessUrl;

    const response = await createCheckout(
      this.options as any,
      {
        productId: this.teamStandardProductId,
        units: input.seatCount,
        successUrl,
        customer: {
          email: input.actorEmail,
        },
        metadata: {
          teamId: input.teamId,
          planFamily: input.planFamily,
          actorUserId: input.actorUserId,
          seatCount: input.seatCount,
        },
        requestId: `team-subscription:${input.teamId}:${Date.now()}`,
      } as any,
    );

    const checkoutUrl = pickString(response, [
      "url",
      "checkoutUrl",
      "checkout_url",
    ]);
    if (!checkoutUrl) {
      throw new BillingError(
        "CREEM_CHECKOUT_URL_MISSING",
        502,
        "Creem checkout did not return a checkout URL",
      );
    }

    return {
      provider: "creem",
      checkoutUrl,
    };
  }

  async createPortal(
    input: BillingProviderPortalInput,
  ): Promise<BillingProviderPortalResult> {
    const response = await createPortal(
      this.options as any,
      {
        customerId: input.externalCustomerId,
        metadata: {
          teamId: input.teamId,
          actorUserId: input.actorUserId,
        },
      } as any,
    );

    const portalUrl = pickString(response, ["url", "portalUrl", "portal_url"]);

    return {
      provider: "creem",
      portalUrl,
    };
  }

  async cancelSubscription(
    input: BillingProviderCancelInput,
  ): Promise<BillingProviderCancelResult> {
    const response = await cancelSubscription(
      this.options as any,
      {
        id: input.externalSubscriptionId,
        metadata: {
          teamId: input.teamId,
          actorUserId: input.actorUserId,
        },
      } as any,
    );

    const status = pickSubscriptionStatus(response) || "canceled";
    const cancelAtPeriodEnd =
      pickBoolean(response, ["cancelAtPeriodEnd", "cancel_at_period_end"]) ??
      true;

    return {
      provider: "creem",
      status,
      cancelAtPeriodEnd,
    };
  }
}
