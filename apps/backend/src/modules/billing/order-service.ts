import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  adjectives,
  colors,
  names,
  uniqueNamesGenerator,
} from "unique-names-generator";
import type {
  BillingInterval,
  CreatePricingCheckoutRequest,
  CreatePricingCheckoutResponse,
  CreateTopupCheckoutRequest,
  CreateTopupCheckoutResponse,
} from "@sourceweft/contracts";
import { getAnchoredMonthlyCycleWindow } from "@sourceweft/credits-core";
import { createSourceweftOrganizationMetadata } from "../auth/organization-metadata";
import { workspaceService } from "../workspace";
import { BillingAccountService } from "./account-service";
import {
  getSubscriptionCatalogEntry,
  getTopupCatalogEntry,
  pricingPlanToPlanFamily,
  resolveSubscriptionProduct,
  validateBillingCatalog,
} from "./catalog";
import { BillingError } from "./errors";
import {
  appendBillingLedger,
  createOperationId,
  formatSignedLedgerDelta,
  scopeMemberLedgerKey,
} from "./ledger";
import type { BillingStore } from "./store-port";
import type {
  BillingAccountState,
  BillingOrderState,
  BillingProviderAdapter,
  BillingRuntimeConfig,
  TeamSubscriptionSnapshot,
} from "./types";
import { getTotalPagesBalance, grantAddOnPages } from "./page-ledger";
import {
  ensureBillingCheckoutEnabled,
  ensureTeamBillingEnabled,
  getTotalCreditsBalance,
  INDIVIDUAL_PRO_PLAN,
  TEAM_STANDARD_PLAN,
} from "./service-helpers";

type BillingAlertSink = {
  trigger(input: {
    alertKey: string;
    level: "warn" | "error" | "critical";
    source: string;
    title: string;
    message: string;
    teamId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
};

type Actor = {
  userId: string;
  email: string;
};

type FulfillInput = {
  orderId: string;
  externalPaymentId?: string | null;
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
  externalSubscriptionItemId?: string | null;
  externalProductId?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  status?: TeamSubscriptionSnapshot["status"];
  metadata?: Record<string, unknown>;
};

export type BillingOrderReconcileResult = {
  checked: number;
  retried: number;
  failed: number;
};

const REUSABLE_ORDER_STATUSES = new Set<BillingOrderState["status"]>([
  "pending",
  "checkout_created",
]);

const RECOVERABLE_CHECKOUT_STATUSES = new Set<BillingOrderState["status"]>([
  "pending",
  "checkout_created",
  "payment_failed",
]);

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "past_due"]);
const TEAM_SEAT_MIN = 2;
const TEAM_SEAT_MAX = 99;

function hasCheckoutUrl(order: BillingOrderState) {
  return (
    typeof order.metadata.checkoutUrl === "string" &&
    order.metadata.checkoutUrl.trim().length > 0
  );
}

function normalizeTeamName(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function generateFallbackTeamName() {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, names],
    separator: " ",
    style: "capital",
  });
}

function isMonthlyOrYearly(
  value: BillingInterval | null,
): value is Exclude<BillingInterval, "unknown"> {
  return value === "monthly" || value === "yearly";
}

function toCheckoutResponse(
  order: BillingOrderState,
): CreatePricingCheckoutResponse {
  if (
    !order.planFamily ||
    (order.planFamily !== INDIVIDUAL_PRO_PLAN &&
      order.planFamily !== TEAM_STANDARD_PLAN) ||
    !isMonthlyOrYearly(order.billingInterval)
  ) {
    throw new BillingError(
      "BILLING_ORDER_INVALID",
      500,
      "Billing order is missing subscription checkout fields",
      { orderId: order.id },
    );
  }

  const checkoutUrl = String(order.metadata.checkoutUrl ?? "");
  if (!checkoutUrl) {
    throw new BillingError(
      "BILLING_CHECKOUT_URL_MISSING",
      409,
      "Checkout URL is not available for this order",
      { orderId: order.id },
    );
  }

  return {
    orderId: order.id,
    provider: order.provider,
    checkoutUrl,
    status: order.status,
    paymentStatus: order.paymentStatus,
    teamId: order.teamId,
    planFamily: order.planFamily,
    billingInterval: order.billingInterval,
    quantity: order.quantity,
  };
}

function toTopupResponse(
  order: BillingOrderState,
): CreateTopupCheckoutResponse {
  const checkoutUrl = String(order.metadata.checkoutUrl ?? "");
  if (!checkoutUrl || !order.unitType || !order.unitAmount) {
    throw new BillingError(
      "BILLING_ORDER_INVALID",
      500,
      "Billing order is missing top-up checkout fields",
      { orderId: order.id },
    );
  }

  return {
    orderId: order.id,
    teamId: order.teamId ?? "",
    provider: order.provider,
    checkoutUrl,
    status: order.status,
    paymentStatus: order.paymentStatus,
    unitType: order.unitType,
    quantity: order.quantity,
    unitAmount: order.unitAmount,
    grantedCredits: order.grantedCredits,
    grantedPages: order.grantedPages,
    amountUsd: (order.amountTotal ?? 0) / 100,
  };
}

function defaultSuccessUrl(
  runtimeConfig: BillingRuntimeConfig,
  orderId: string,
) {
  const configured = runtimeConfig.defaultSuccessUrl;
  const separator = configured.includes("?") ? "&" : "?";
  return `${configured}${separator}orderId=${encodeURIComponent(orderId)}`;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function normalizeClientReferenceKey(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizeTeamSeatCount(value: number | undefined) {
  if (value === undefined) {
    return TEAM_SEAT_MIN;
  }

  const seatCount = Math.floor(value);
  if (
    !Number.isFinite(seatCount) ||
    seatCount < TEAM_SEAT_MIN ||
    seatCount > TEAM_SEAT_MAX
  ) {
    throw new BillingError(
      "INVALID_SEAT_COUNT",
      400,
      `seatCount must be between ${TEAM_SEAT_MIN} and ${TEAM_SEAT_MAX}`,
    );
  }

  return seatCount;
}

function buildRetryAt() {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}

function createOrderBase(input: {
  provider: BillingRuntimeConfig["provider"];
  kind: BillingOrderState["kind"];
  userId: string;
  teamId: string | null;
  clientReferenceKey: string | null;
  planFamily: BillingOrderState["planFamily"];
  billingInterval: BillingOrderState["billingInterval"];
  quantity: number;
  unitType: BillingOrderState["unitType"];
  unitAmount: BillingOrderState["unitAmount"];
  grantedCredits: number;
  grantedPages: number;
  externalProductId: string | null;
  amountTotal: number | null;
  currency: string | null;
  successUrl: string | null;
  cancelUrl: string | null;
  metadata: Record<string, unknown>;
}): BillingOrderState {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    provider: input.provider,
    kind: input.kind,
    status: "pending",
    paymentStatus: "unpaid",
    userId: input.userId,
    teamId: input.teamId,
    clientReferenceKey: input.clientReferenceKey,
    planFamily: input.planFamily,
    billingInterval: input.billingInterval,
    quantity: input.quantity,
    unitType: input.unitType,
    unitAmount: input.unitAmount,
    grantedCredits: input.grantedCredits,
    grantedPages: input.grantedPages,
    externalCheckoutId: null,
    externalPaymentId: null,
    externalCustomerId: null,
    externalSubscriptionId: null,
    externalProductId: input.externalProductId,
    amountTotal: input.amountTotal,
    currency: input.currency,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata: input.metadata,
    errorCode: null,
    errorMessage: null,
    paidAt: null,
    fulfilledAt: null,
    expiresAt: null,
    fulfillmentAttemptCount: 0,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Purchase-flow layer: money-for-entitlement orders, from checkout to
 * fulfillment.
 *
 * Owns the `billing_orders` state machine for pricing checkouts (individual
 * pro, team subscriptions — creating the paid team organization on first
 * fulfillment) and credit/page top-ups: create or reuse an open order, send the
 * buyer to the provider's checkout, then fulfill exactly once when payment
 * confirms (webhook or reconcile retry). Fulfillment is idempotency-keyed on
 * the order id, so a replayed webhook grants nothing twice.
 *
 * Dependencies point downward: rows lock via `account-service`, entries write
 * via `ledger`, catalog/product resolution via `catalog`. This layer decides
 * WHAT was purchased; the ledger primitives decide how balances move — the
 * inline `addOnCreditsBalance` bump in `fulfillTopupOrderLocked` is the known
 * exception where this flow still edits bucket state directly (the pages half
 * goes through `grantAddOnPages`). It never meters usage; `usage-service`
 * calls in for top-up checkout, not the reverse.
 * Subscription fulfillment applies plan/cycle state member-by-member through
 * `account-service`'s locked lifecycle methods, fanning out over the members
 * inside the order transaction.
 */
export class BillingOrderService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly provider: BillingProviderAdapter,
    private readonly accountService: BillingAccountService,
    private readonly alerts?: BillingAlertSink,
  ) {}

  async createPricingCheckout(input: {
    request: CreatePricingCheckoutRequest;
    actor: Actor;
    personalTeamId?: string | null;
  }): Promise<CreatePricingCheckoutResponse> {
    const planFamily = pricingPlanToPlanFamily(input.request.plan);
    ensureBillingCheckoutEnabled(this.runtimeConfig);
    validateBillingCatalog({
      runtimeConfig: this.runtimeConfig,
      subscriptionPlanFamilies: [planFamily],
      topupUnitTypes: [],
    });

    if (planFamily === TEAM_STANDARD_PLAN) {
      ensureTeamBillingEnabled(this.runtimeConfig);
    }

    const catalogEntry = getSubscriptionCatalogEntry(
      this.runtimeConfig,
      planFamily,
    );
    const billingInterval = input.request.billingInterval;
    const quantity =
      planFamily === TEAM_STANDARD_PLAN
        ? normalizeTeamSeatCount(input.request.seatCount)
        : catalogEntry.defaultQuantity;
    const product = resolveSubscriptionProduct({
      runtimeConfig: this.runtimeConfig,
      planFamily,
      billingInterval,
    });
    const teamId =
      planFamily === INDIVIDUAL_PRO_PLAN
        ? (input.personalTeamId ?? null)
        : null;

    if (planFamily === INDIVIDUAL_PRO_PLAN && !teamId) {
      throw new BillingError(
        "PERSONAL_ORG_REQUIRED",
        409,
        "A personal organization is required before starting Pro checkout",
      );
    }

    if (planFamily === INDIVIDUAL_PRO_PLAN) {
      await this.rejectIfActiveSubscription(teamId);
    }

    const clientReferenceKey = normalizeClientReferenceKey(
      input.request.clientReferenceKey,
    );
    if (clientReferenceKey) {
      const existing = await this.store.getOrderByClientReference(
        input.actor.userId,
        clientReferenceKey,
      );
      if (existing && hasCheckoutUrl(existing)) {
        return toCheckoutResponse(existing);
      }
      if (
        existing &&
        RECOVERABLE_CHECKOUT_STATUSES.has(existing.status) &&
        existing.kind === "subscription" &&
        existing.planFamily === planFamily &&
        existing.billingInterval === billingInterval
      ) {
        const recovered = await this.createProviderCheckoutForSubscriptionOrder(
          {
            order: existing,
            actor: input.actor,
            planFamily,
            billingInterval,
            quantity,
            productId: product.productId,
          },
        );
        return toCheckoutResponse(recovered);
      }
    }

    if (planFamily === INDIVIDUAL_PRO_PLAN) {
      const reusable = await this.store.findOpenSubscriptionOrder({
        userId: input.actor.userId,
        teamId,
        planFamily,
        billingInterval,
      });
      if (
        reusable &&
        REUSABLE_ORDER_STATUSES.has(reusable.status) &&
        hasCheckoutUrl(reusable)
      ) {
        return toCheckoutResponse(reusable);
      }
    }

    const draft = createOrderBase({
      provider: this.runtimeConfig.provider,
      kind: "subscription",
      userId: input.actor.userId,
      teamId,
      clientReferenceKey,
      planFamily,
      billingInterval,
      quantity,
      unitType: null,
      unitAmount: null,
      grantedCredits: 0,
      grantedPages: 0,
      externalProductId: product.productId || null,
      amountTotal: product.amountCents * quantity,
      currency: product.currency,
      successUrl: input.request.successUrl ?? null,
      cancelUrl: input.request.cancelUrl ?? null,
      metadata: {
        source: input.request.source,
        audience: catalogEntry.audience,
        minQuantity: catalogEntry.minQuantity,
        ...(planFamily === TEAM_STANDARD_PLAN && input.request.teamName
          ? { teamName: input.request.teamName.trim() }
          : {}),
      },
    });
    draft.successUrl =
      input.request.successUrl ??
      defaultSuccessUrl(this.runtimeConfig, draft.id);

    let order = await this.store.insertOrder(draft);
    order = await this.createProviderCheckoutForSubscriptionOrder({
      order,
      actor: input.actor,
      planFamily,
      billingInterval,
      quantity,
      productId: product.productId,
    });

    return toCheckoutResponse(order);
  }

  async createTopupCheckout(input: {
    teamId: string;
    request: CreateTopupCheckoutRequest;
    actor: Actor;
  }): Promise<CreateTopupCheckoutResponse> {
    const unitType = input.request.unitType;
    ensureBillingCheckoutEnabled(this.runtimeConfig);
    validateBillingCatalog({
      runtimeConfig: this.runtimeConfig,
      subscriptionPlanFamilies: [],
      topupUnitTypes: [unitType],
    });

    const quantity = Math.floor(input.request.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BillingError(
        "INVALID_TOPUP_QUANTITY",
        400,
        "Top-up quantity must be greater than zero",
      );
    }

    const catalogEntry = getTopupCatalogEntry(this.runtimeConfig, unitType);
    const grantedCredits =
      unitType === "credit" ? catalogEntry.unitAmount * quantity : 0;
    const grantedPages =
      unitType === "page" ? catalogEntry.unitAmount * quantity : 0;
    const clientReferenceKey = normalizeClientReferenceKey(
      input.request.clientReferenceKey,
    );

    if (clientReferenceKey) {
      const existing = await this.store.getOrderByClientReference(
        input.actor.userId,
        clientReferenceKey,
      );
      if (existing) {
        return toTopupResponse(existing);
      }
    }

    const draft = createOrderBase({
      provider: this.runtimeConfig.provider,
      kind: catalogEntry.kind,
      userId: input.actor.userId,
      teamId: input.teamId,
      clientReferenceKey,
      planFamily: null,
      billingInterval: null,
      quantity,
      unitType,
      unitAmount: catalogEntry.unitAmount,
      grantedCredits,
      grantedPages,
      externalProductId: catalogEntry.productId || null,
      amountTotal: catalogEntry.amountCents * quantity,
      currency: "usd",
      successUrl: input.request.successUrl ?? null,
      cancelUrl: input.request.cancelUrl ?? null,
      metadata: {
        unitType,
        unitAmount: catalogEntry.unitAmount,
      },
    });
    draft.successUrl =
      input.request.successUrl ??
      defaultSuccessUrl(this.runtimeConfig, draft.id);

    let order = await this.store.insertOrder(draft);
    const providerResult = await this.provider.createCheckout({
      orderId: order.id,
      persistedOrder: true,
      kind: order.kind,
      teamId: order.teamId,
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      planFamily: null,
      billingInterval: null,
      quantity,
      unitType,
      unitAmount: catalogEntry.unitAmount,
      grantedCredits,
      grantedPages,
      externalProductId: catalogEntry.productId,
      amountTotal: order.amountTotal,
      currency: order.currency,
      successUrl: order.successUrl ?? undefined,
      cancelUrl: order.cancelUrl ?? undefined,
      metadata: order.metadata,
    });

    order = await this.store.updateOrder({
      ...order,
      provider: providerResult.provider,
      status: "checkout_created",
      externalCheckoutId: providerResult.externalCheckoutId,
      externalCustomerId: providerResult.externalCustomerId,
      metadata: {
        ...order.metadata,
        checkoutUrl: providerResult.checkoutUrl,
      },
      updatedAt: new Date().toISOString(),
    });

    return toTopupResponse(order);
  }

  private async createProviderCheckoutForSubscriptionOrder(input: {
    order: BillingOrderState;
    actor: Actor;
    planFamily: typeof INDIVIDUAL_PRO_PLAN | typeof TEAM_STANDARD_PLAN;
    billingInterval: Exclude<BillingInterval, "unknown">;
    quantity: number;
    productId: string;
  }) {
    let providerResult;
    try {
      providerResult = await this.provider.createCheckout({
        orderId: input.order.id,
        persistedOrder: true,
        kind: input.order.kind,
        teamId: input.order.teamId,
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        planFamily: input.planFamily,
        billingInterval: input.billingInterval,
        quantity: input.quantity,
        externalProductId: input.productId,
        amountTotal: input.order.amountTotal,
        currency: input.order.currency,
        successUrl: input.order.successUrl ?? undefined,
        cancelUrl: input.order.cancelUrl ?? undefined,
        metadata: input.order.metadata,
      });
    } catch (error) {
      await this.store.updateOrder({
        ...input.order,
        status: "payment_failed",
        paymentStatus: "failed",
        errorCode:
          error instanceof BillingError
            ? error.code
            : "BILLING_CHECKOUT_CREATE_FAILED",
        errorMessage:
          error instanceof Error
            ? error.message
            : "Unable to create billing checkout",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }

    return this.store.updateOrder({
      ...input.order,
      provider: providerResult.provider,
      status: "checkout_created",
      paymentStatus: "unpaid",
      externalCheckoutId: providerResult.externalCheckoutId,
      externalCustomerId: providerResult.externalCustomerId,
      metadata: {
        ...input.order.metadata,
        checkoutUrl: providerResult.checkoutUrl,
      },
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    });
  }

  getOrder(orderId: string) {
    return this.store.getOrderById(orderId);
  }

  async reconcileRetryableOrders(): Promise<BillingOrderReconcileResult> {
    const orders = await this.store.listRetryableOrders({ limit: 25 });
    const result: BillingOrderReconcileResult = {
      checked: orders.length,
      retried: 0,
      failed: 0,
    };

    for (const order of orders) {
      try {
        await this.fulfillOrder({
          orderId: order.id,
          externalCustomerId: order.externalCustomerId,
          externalSubscriptionId: order.externalSubscriptionId,
          externalProductId: order.externalProductId,
          currentPeriodStart:
            typeof order.metadata.currentPeriodStart === "string"
              ? order.metadata.currentPeriodStart
              : null,
          currentPeriodEnd:
            typeof order.metadata.currentPeriodEnd === "string"
              ? order.metadata.currentPeriodEnd
              : null,
          metadata: {
            source: "billing_order_reconcile",
          },
        });
        result.retried += 1;
      } catch {
        result.failed += 1;
      }
    }

    return result;
  }

  async fulfillOrder(input: FulfillInput) {
    try {
      return await this.store.runInTransaction(async (client) => {
        const order = await this.store.getOrderByIdForUpdate(
          input.orderId,
          client,
        );
        if (!order) {
          throw new BillingError(
            "BILLING_ORDER_NOT_FOUND",
            404,
            "Billing order not found",
          );
        }

        if (order.status === "fulfilled") {
          return order;
        }

        const confirmed = await this.store.updateOrder(
          {
            ...order,
            status: "payment_confirmed",
            paymentStatus: "paid",
            externalPaymentId:
              input.externalPaymentId ?? order.externalPaymentId,
            externalCustomerId:
              input.externalCustomerId ?? order.externalCustomerId,
            externalSubscriptionId:
              input.externalSubscriptionId ?? order.externalSubscriptionId,
            externalProductId:
              input.externalProductId ?? order.externalProductId,
            paidAt: order.paidAt ?? new Date().toISOString(),
            fulfillmentAttemptCount: order.fulfillmentAttemptCount + 1,
            metadata: {
              ...order.metadata,
              ...(input.metadata ?? {}),
              ...(input.externalSubscriptionItemId
                ? {
                    externalSubscriptionItemId:
                      input.externalSubscriptionItemId,
                  }
                : {}),
            },
            errorCode: null,
            errorMessage: null,
            updatedAt: new Date().toISOString(),
          },
          client,
        );

        if (confirmed.kind === "subscription") {
          return this.fulfillSubscriptionOrderLocked(confirmed, input, client);
        }

        return this.fulfillTopupOrderLocked(confirmed, client);
      });
    } catch (error) {
      await this.markFulfillmentFailed(input.orderId, error);
      throw error;
    }
  }

  private async rejectIfActiveSubscription(teamId: string | null) {
    if (!teamId) {
      return;
    }

    const subscription = await this.store.getSubscriptionByTeam(teamId);
    if (
      subscription &&
      subscription.planFamily === INDIVIDUAL_PRO_PLAN &&
      ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)
    ) {
      throw new BillingError(
        "SUBSCRIPTION_ALREADY_ACTIVE",
        409,
        "Pro is already active for this personal organization",
      );
    }
  }

  private async fulfillSubscriptionOrderLocked(
    order: BillingOrderState,
    input: FulfillInput,
    client: PoolClient,
  ) {
    if (
      !order.planFamily ||
      (order.planFamily !== INDIVIDUAL_PRO_PLAN &&
        order.planFamily !== TEAM_STANDARD_PLAN) ||
      !isMonthlyOrYearly(order.billingInterval)
    ) {
      throw new BillingError(
        "BILLING_ORDER_INVALID",
        422,
        "Subscription order is missing required metadata",
        { orderId: order.id },
      );
    }

    const now = new Date();
    const period = this.resolveSubscriptionPeriod(order.billingInterval, input);
    if (order.planFamily === TEAM_STANDARD_PLAN) {
      ensureTeamBillingEnabled(this.runtimeConfig);
    }

    const teamId =
      order.planFamily === TEAM_STANDARD_PLAN
        ? await this.ensurePaidTeamOrganization(order)
        : order.teamId;

    if (!teamId) {
      throw new BillingError(
        "BILLING_ORDER_TEAM_MISSING",
        422,
        "Subscription order cannot be fulfilled without a team",
        { orderId: order.id },
      );
    }

    const snapshot: TeamSubscriptionSnapshot = {
      teamId,
      provider: order.provider,
      planFamily: order.planFamily,
      status: input.status ?? "active",
      billingInterval: order.billingInterval,
      currentPeriodStart: period.startAt.toISOString(),
      currentPeriodEnd: period.endAt.toISOString(),
      externalCustomerId: input.externalCustomerId ?? order.externalCustomerId,
      externalSubscriptionId:
        input.externalSubscriptionId ?? order.externalSubscriptionId,
      externalSubscriptionItemId: input.externalSubscriptionItemId ?? null,
      externalProductId: input.externalProductId ?? order.externalProductId,
      billingOrderId: order.id,
      cancelAtPeriodEnd: false,
      metadata: {
        ...order.metadata,
        orderId: order.id,
      },
      seatCount:
        order.planFamily === TEAM_STANDARD_PLAN
          ? Math.max(2, order.quantity)
          : 1,
    };

    // Activating (or changing) the team plan is a team-wide change: every
    // current member's row must receive the new plan's per-seat allocation.
    // We are already inside fulfillOrder's transaction (holding the order row
    // locked), and runInTransaction opens a fresh connection rather than
    // nesting, so we can't use withLockedTeamAccounts here — instead we fan out
    // over the same client, ensuring+locking each member's row exactly as
    // withLockedTeamAccounts would. The team-wide subscription upsert is emitted
    // exactly once (on the first member).
    const memberUserIds = await this.store.listTeamMemberUserIds(
      teamId,
      client,
    );
    let upsertSubscriptionOnce = true;
    for (const memberUserId of memberUserIds) {
      const account = await this.accountService.ensureAccountLocked(
        teamId,
        memberUserId,
        client,
      );
      await this.applySubscriptionSnapshotLocked(account, snapshot, client, {
        upsertSubscription: upsertSubscriptionOnce,
      });
      upsertSubscriptionOnce = false;
    }

    return this.store.updateOrder(
      {
        ...order,
        teamId,
        status: "fulfilled",
        paymentStatus: "paid",
        externalCustomerId: snapshot.externalCustomerId,
        externalSubscriptionId: snapshot.externalSubscriptionId,
        externalProductId: snapshot.externalProductId,
        fulfilledAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      client,
    );
  }

  private async fulfillTopupOrderLocked(
    order: BillingOrderState,
    client: PoolClient,
  ) {
    if (!order.teamId || !order.unitType || !order.unitAmount) {
      throw new BillingError(
        "BILLING_ORDER_INVALID",
        422,
        "Top-up order is missing required metadata",
        { orderId: order.id },
      );
    }

    // Top-up grants land on the PURCHASING member's own row (谁问谁付): the
    // buyer is the order's actor (`order.userId`).
    const account = await this.accountService.ensureAccountLocked(
      order.teamId,
      order.userId,
      client,
    );
    const grantAmount =
      order.unitType === "credit" ? order.grantedCredits : order.grantedPages;
    if (grantAmount <= 0) {
      throw new BillingError(
        "BILLING_ORDER_INVALID_GRANT",
        422,
        "Top-up order has no grant amount",
        { orderId: order.id },
      );
    }

    const existingLedger = await this.store.getLedgerByIdempotency(
      order.teamId,
      scopeMemberLedgerKey(account.userId, `billing-order:${order.id}:grant`),
      client,
    );

    if (!existingLedger) {
      if (order.unitType === "credit") {
        // Credits still lack a grant primitive (credit math lives in
        // `service-helpers`); primitive-izing this bump is follow-up work.
        account.addOnCreditsBalance += grantAmount;
      } else {
        grantAddOnPages(account, grantAmount);
      }

      await appendBillingLedger({
        store: this.store,
        client,
        account,
        entry: {
          eventType: "grant",
          unitType: order.unitType,
          delta: grantAmount,
          balanceAfter:
            order.unitType === "credit"
              ? getTotalCreditsBalance(account)
              : getTotalPagesBalance(account),
          feature:
            order.unitType === "credit"
              ? "credit_topup_purchase"
              : "page_topup_purchase",
          actorUserId: order.userId,
          referenceId: order.id,
          idempotencyKey: `billing-order:${order.id}:grant`,
          operationId: createOperationId("topup", order.teamId, order.id),
          operationType: "topup",
          activityVisible: true,
          activityTitle:
            order.unitType === "credit"
              ? "Credits top-up purchased"
              : "Pages top-up purchased",
          activitySummary: formatSignedLedgerDelta(order.unitType, grantAmount),
          metadata: {
            orderId: order.id,
            quantity: order.quantity,
            unitAmount: order.unitAmount,
          },
        },
      });

      account.updatedAt = new Date().toISOString();
      await this.store.updateAccount(account, client);
    }

    return this.store.updateOrder(
      {
        ...order,
        status: "fulfilled",
        paymentStatus: "paid",
        fulfilledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      client,
    );
  }

  private async ensurePaidTeamOrganization(order: BillingOrderState) {
    if (order.teamId) {
      return order.teamId;
    }

    const teamName =
      normalizeTeamName(order.metadata.teamName) || generateFallbackTeamName();
    const metadata = {
      ...createSourceweftOrganizationMetadata("team"),
      sourceweft: {
        kind: "team",
        billingOrderId: order.id,
      },
    };
    const created = await workspaceService.createTeamOrganization({
      name: teamName,
      slug: `team-${order.id.slice(0, 8)}`,
      userId: order.userId,
      metadata,
      idempotencyKey: order.id,
    });

    if (created.created) {
      await workspaceService.ensureMembershipWorkspace({
        organizationId: created.id,
        userId: order.userId,
      });
    }

    return created.id;
  }

  private resolveSubscriptionPeriod(
    billingInterval: Exclude<BillingInterval, "unknown">,
    input: FulfillInput,
  ) {
    const providedStart = input.currentPeriodStart
      ? new Date(input.currentPeriodStart)
      : null;
    const providedEnd = input.currentPeriodEnd
      ? new Date(input.currentPeriodEnd)
      : null;

    if (
      providedStart &&
      providedEnd &&
      !Number.isNaN(providedStart.getTime()) &&
      !Number.isNaN(providedEnd.getTime()) &&
      providedEnd > providedStart
    ) {
      return { startAt: providedStart, endAt: providedEnd };
    }

    const startAt = new Date();
    if (billingInterval === "monthly") {
      return { startAt, endAt: addMonths(startAt, 1) };
    }

    return { startAt, endAt: addMonths(startAt, 12) };
  }

  private async applySubscriptionSnapshotLocked(
    account: BillingAccountState,
    snapshot: TeamSubscriptionSnapshot,
    client: PoolClient,
    options: { upsertSubscription: boolean } = { upsertSubscription: true },
  ) {
    // The subscription row is a team-wide record; only upsert it once even when
    // this runs per-member as part of a team fan-out.
    if (options.upsertSubscription) {
      await this.store.upsertSubscription(snapshot, client);
    }

    const previousSeatCount = account.seatCount;
    account.seatCount = snapshot.seatCount;
    await this.accountService.applyPlanFamilyLocked(
      account,
      snapshot.planFamily,
      client,
      {
        source: "billing_order_fulfillment",
        provider: snapshot.provider,
        orderId: snapshot.billingOrderId,
        externalSubscriptionId: snapshot.externalSubscriptionId,
        suppressImmediateGrant: true,
      },
    );

    if (previousSeatCount !== account.seatCount) {
      await this.accountService.refreshPlanQuotaLocked(account, client, {
        source: "billing_order_fulfillment",
        provider: snapshot.provider,
        orderId: snapshot.billingOrderId,
        externalSubscriptionId: snapshot.externalSubscriptionId,
        reason: "subscription_created",
        previousSeatCount,
        nextSeatCount: account.seatCount,
      });
    }

    const cycle =
      snapshot.billingInterval === "monthly"
        ? {
            startAt: new Date(snapshot.currentPeriodStart ?? new Date()),
            endAt: new Date(
              snapshot.currentPeriodEnd ?? addMonths(new Date(), 1),
            ),
          }
        : getAnchoredMonthlyCycleWindow(
            new Date(),
            new Date(snapshot.currentPeriodStart ?? new Date()),
          );

    await this.accountService.realignCycleLocked(account, client, {
      cycleAnchorAt: snapshot.currentPeriodStart ?? new Date().toISOString(),
      cycleSource: "provider_subscription",
      cycleStartAt: cycle.startAt.toISOString(),
      cycleEndAt: cycle.endAt.toISOString(),
      expireCurrentMonthly: true,
      grantNewMonthly: true,
      metadata: {
        source: "billing_order_fulfillment",
        provider: snapshot.provider,
        orderId: snapshot.billingOrderId,
        planFamily: snapshot.planFamily,
        billingInterval: snapshot.billingInterval,
      },
    });
  }

  private async markFulfillmentFailed(orderId: string, error: unknown) {
    const order = await this.store.getOrderById(orderId);
    if (!order || order.status === "fulfilled") {
      return;
    }

    const message =
      error instanceof Error ? error.message : "Unknown fulfillment error";
    const code =
      error instanceof BillingError ? error.code : "BILLING_FULFILLMENT_FAILED";
    await this.store.updateOrder({
      ...order,
      status: "fulfillment_failed",
      errorCode: code,
      errorMessage: message,
      nextRetryAt: buildRetryAt(),
      updatedAt: new Date().toISOString(),
    });

    await this.alerts?.trigger({
      alertKey: `billing:order-fulfillment:${orderId}`,
      level: "error",
      source: "billing.orders",
      title: "Billing order fulfillment failed",
      message,
      teamId: order.teamId,
      metadata: {
        orderId,
        code,
      },
    });
  }
}
