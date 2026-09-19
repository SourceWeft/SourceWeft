import { BillingSubscriptionService } from "./subscription-service";
import { assertSubscriptionPurchaseAllowed } from "./subscription-policy";
import { createHash, randomUUID } from "node:crypto";
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
import type { BillingServiceHost } from "./host";
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
  grantAddOnCredits,
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

const RECOVERABLE_CHECKOUT_STATUSES = new Set<BillingOrderState["status"]>([
  "pending",
  "checkout_created",
  "payment_failed",
  "expired",
]);

const TEAM_SEAT_MIN = 2;
const TEAM_SEAT_MAX = 99;

function hasCheckoutUrl(order: BillingOrderState) {
  return (
    order.status !== "expired" &&
    order.status !== "payment_failed" &&
    typeof order.metadata.checkoutUrl === "string" &&
    order.metadata.checkoutUrl.trim().length > 0 &&
    (!order.expiresAt || Date.parse(order.expiresAt) > Date.now())
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

function normalizeClientReferenceKey(
  value: string | undefined,
  config: BillingRuntimeConfig,
  scope?: string,
) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (config.provider === "stripe")
    return `stripe:${scope}:${config.stripe.testMode ? "test" : "live"}:${trimmed}`;
  return config.provider === "waffo"
    ? `waffo:${config.waffo.merchantId}:${config.waffo.environment}:${trimmed}`
    : trimmed;
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
 * WHAT was purchased; the ledger primitives decide how balances move — both
 * top-up halves in `fulfillTopupOrderLocked` grant through one
 * (`grantAddOnCredits` / `grantAddOnPages`), so this flow never edits bucket
 * state directly. It never meters usage; `usage-service`
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
    private readonly host?: BillingServiceHost,
  ) {}

  async createPricingCheckout(input: {
    request: CreatePricingCheckoutRequest;
    actor: Actor;
    personalTeamId?: string | null;
    existingTeamId?: string;
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

    const checkoutScope = await this.provider.getCheckoutScope?.();
    const clientReferenceKey = normalizeClientReferenceKey(
      input.request.clientReferenceKey,
      this.runtimeConfig,
      checkoutScope,
    );
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
        ...(input.existingTeamId
          ? { existingTeamId: input.existingTeamId }
          : {}),
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

    const target = input.existingTeamId ?? teamId;
    const targetKey = target
      ? `team:${target}`
      : `purchase:${input.actor.userId}:${clientReferenceKey ?? draft.id}`;
    draft.metadata = {
      ...draft.metadata,
      ...(await this.provider.checkoutMetadata?.()),
      subscriptionTarget: targetKey,
      checkoutActorEmail: input.actor.email,
    };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          input.actor.userId,
          this.runtimeConfig.provider,
          checkoutScope,
          this.runtimeConfig.provider === "waffo"
            ? this.runtimeConfig.waffo.environment
            : this.runtimeConfig.provider === "stripe"
              ? this.runtimeConfig.stripe.testMode
              : this.runtimeConfig.creem.testMode,
          planFamily,
          billingInterval,
          quantity,
          product.amountCents,
          input.request.successUrl ?? null,
        ]),
      )
      .digest("hex");
    // A different purchase can replace an abandoned operation only after the provider
    // confirms the original checkout is no longer payable. Time alone is not proof.
    const candidate = await this.store.runInTransaction((client) =>
      this.store.getOpenSubscriptionOperation(targetKey, client),
    );
    if (
      candidate?.kind === "purchase" &&
      candidate.requestHash !== requestHash &&
      candidate.orderId &&
      candidate.status === "awaiting_confirmation" &&
      this.provider.inspectCheckout
    ) {
      const previous = await this.store.getOrderById(candidate.orderId);
      const sameScope =
        previous?.provider === this.runtimeConfig.provider &&
        (previous.provider !== "stripe" ||
          (previous.metadata.stripeAccountId === checkoutScope &&
            previous.metadata.stripeTestMode ===
              this.runtimeConfig.stripe.testMode)) &&
        (previous.provider !== "waffo" ||
          (previous.metadata.waffoMerchantId ===
            this.runtimeConfig.waffo.merchantId &&
            previous.metadata.waffoEnvironment ===
              this.runtimeConfig.waffo.environment));
      if (
        previous &&
        sameScope &&
        (await this.provider.inspectCheckout(previous)) === "expired"
      ) {
        await this.store.runInTransaction(async (client) => {
          await this.store.lockSubscriptionTarget(targetKey, client);
          const latest = await this.store.getOpenSubscriptionOperation(
            targetKey,
            client,
          );
          const order = await this.store.getOrderById(previous.id, client);
          if (
            latest?.id === candidate.id &&
            latest.status === "awaiting_confirmation" &&
            order?.paymentStatus !== "paid"
          )
            await this.store.saveSubscriptionOperation(
              { ...latest, status: "failed" },
              client,
            );
        });
      }
    }
    const reserve = await this.store.runInTransaction(async (client) => {
      await this.store.lockSubscriptionTarget(targetKey, client);
      if (target) {
        assertSubscriptionPurchaseAllowed(
          await this.store.getSubscriptionByTeam(target, client),
        );
        if (planFamily === TEAM_STANDARD_PLAN) {
          const occupied =
            (await this.store.countTeamMembers(target, client)) +
            (await this.store.countPendingTeamInvitations(target, client));
          if (quantity < occupied)
            throw new BillingError(
              "SEAT_COUNT_BELOW_ALLOCATED_SEATS",
              409,
              "Seats cannot be fewer than members and pending invitations",
            );
        }
      }
      const open = await this.store.getOpenSubscriptionOperation(
        targetKey,
        client,
      );
      if (open) {
        if (open.kind !== "purchase" || open.requestHash !== requestHash)
          throw new BillingError(
            "SUBSCRIPTION_OPERATION_CONFLICT",
            409,
            "Another subscription operation is awaiting resolution",
          );
        const order = open.orderId
          ? await this.store.getOrderById(open.orderId, client)
          : null;
        if (!order)
          throw new BillingError(
            "SUBSCRIPTION_OPERATION_INVALID",
            409,
            "The purchase operation has no order",
          );
        return { order, operation: open, create: false };
      }
      if (
        clientReferenceKey &&
        (await this.store.getOrderByClientReference(
          input.actor.userId,
          clientReferenceKey,
          client,
        ))
      )
        throw new BillingError(
          "BILLING_CHECKOUT_REFERENCE_CONFLICT",
          409,
          "Use a new purchase reference for a different checkout",
        );
      const order = await this.store.insertOrder(draft, client);
      const operation = {
        id: order.id,
        targetKey,
        kind: "purchase" as const,
        requestHash,
        orderId: order.id,
        status: "remote_pending" as const,
        metadata: { requestStartedAt: Date.now(), leaseAt: Date.now() },
      };
      await this.store.saveSubscriptionOperation(operation, client);
      return { order, operation, create: true };
    });
    if (!reserve.create) {
      if (hasCheckoutUrl(reserve.order))
        return toCheckoutResponse(reserve.order);
      const retryWindow = this.provider.checkoutRetryWindowMs ?? 0;
      const requestStartedAt = Number(
        reserve.operation.metadata.requestStartedAt ?? 0,
      );
      const canReplay =
        Date.now() - requestStartedAt < retryWindow &&
        (reserve.operation.status === "needs_resolution" ||
          (reserve.operation.status === "remote_pending" &&
            Date.now() - Number(reserve.operation.metadata.leaseAt ?? 0) >
              90_000));
      const status =
        !canReplay && this.provider.inspectCheckout
          ? await this.provider.inspectCheckout(reserve.order)
          : "unknown";
      if (!canReplay && status !== "expired")
        throw new BillingError(
          "SUBSCRIPTION_PAYMENT_PENDING",
          409,
          "The previous payment result is not resolved; wait for confirmation before retrying",
        );
      await this.store.runInTransaction(async (client) => {
        await this.store.lockSubscriptionTarget(targetKey, client);
        const latest = await this.store.getOpenSubscriptionOperation(
          targetKey,
          client,
        );
        const order = await this.store.getOrderById(reserve.order.id, client);
        if (
          !latest ||
          latest.status !== reserve.operation.status ||
          latest.metadata.leaseAt !== reserve.operation.metadata.leaseAt ||
          (!canReplay && latest.status !== "awaiting_confirmation") ||
          !order ||
          order.paymentStatus === "paid"
        )
          throw new BillingError(
            "SUBSCRIPTION_OPERATION_CONFLICT",
            409,
            "Purchase changed during checkout recovery",
          );
        await this.store.saveSubscriptionOperation(
          {
            ...latest,
            status: "remote_pending",
            metadata: {
              ...latest.metadata,
              leaseAt: Date.now(),
              requestStartedAt: canReplay ? requestStartedAt : Date.now(),
            },
          },
          client,
        );
      });
    }

    try {
      const order = await this.createProviderCheckoutForSubscriptionOrder({
        order: reserve.order,
        actor: input.actor,
        planFamily,
        billingInterval,
        quantity,
        productId: product.productId,
      });
      await this.store.runInTransaction(async (client) => {
        await this.store.lockSubscriptionTarget(targetKey, client);
        const latest = await this.store.getOpenSubscriptionOperation(
          targetKey,
          client,
        );
        if (latest?.id === reserve.operation.id)
          await this.store.saveSubscriptionOperation(
            { ...latest, status: "awaiting_confirmation" },
            client,
          );
      });
      return toCheckoutResponse(order);
    } catch (error) {
      await this.store.runInTransaction(async (client) => {
        await this.store.lockSubscriptionTarget(targetKey, client);
        const latest = await this.store.getOpenSubscriptionOperation(
          targetKey,
          client,
        );
        if (latest?.id === reserve.operation.id)
          await this.store.saveSubscriptionOperation(
            { ...latest, status: "needs_resolution" },
            client,
          );
      });
      throw error;
    }
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
    const checkoutScope = await this.provider.getCheckoutScope?.();
    const clientReferenceKey = normalizeClientReferenceKey(
      input.request.clientReferenceKey,
      this.runtimeConfig,
      checkoutScope,
    );

    if (clientReferenceKey) {
      const existing = await this.store.getOrderByClientReference(
        input.actor.userId,
        clientReferenceKey,
      );
      if (existing) {
        if (
          existing.kind !== catalogEntry.kind ||
          existing.quantity !== quantity ||
          existing.unitType !== unitType ||
          existing.teamId !== input.teamId ||
          existing.provider !== this.runtimeConfig.provider
        )
          throw new BillingError(
            "BILLING_CHECKOUT_REFERENCE_CONFLICT",
            409,
            "This checkout reference belongs to a different purchase",
          );
        if (hasCheckoutUrl(existing) || existing.paymentStatus === "paid")
          return toTopupResponse(existing);
        if (RECOVERABLE_CHECKOUT_STATUSES.has(existing.status))
          return toTopupResponse(
            await this.createProviderTopupCheckout(existing, input.actor),
          );
        throw new BillingError(
          "BILLING_ORDER_NOT_RETRYABLE",
          409,
          "Start a new checkout for this purchase",
        );
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

    draft.metadata = {
      ...draft.metadata,
      ...(await this.provider.checkoutMetadata?.()),
    };
    const order = await this.store.insertOrder(draft);
    return toTopupResponse(
      await this.createProviderTopupCheckout(order, input.actor),
    );
  }

  private async createProviderTopupCheckout(
    order: BillingOrderState,
    actor: Actor,
  ) {
    let providerResult;
    try {
      providerResult = await this.provider.createCheckout({
        orderId: order.id,
        persistedOrder: true,
        previousCheckoutId: order.externalCheckoutId ?? undefined,
        kind: order.kind,
        teamId: order.teamId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        planFamily: null,
        billingInterval: null,
        quantity: order.quantity,
        unitType: order.unitType,
        unitAmount: order.unitAmount,
        grantedCredits: order.grantedCredits,
        grantedPages: order.grantedPages,
        externalProductId: order.externalProductId ?? "",
        amountTotal: order.amountTotal,
        currency: order.currency,
        successUrl: order.successUrl ?? undefined,
        cancelUrl: order.cancelUrl ?? undefined,
        metadata: order.metadata,
      });
    } catch (error) {
      await this.store.updateOrder({
        ...order,
        status: "payment_failed",
        paymentStatus: "failed",
        errorCode:
          error instanceof BillingError
            ? error.code
            : "BILLING_CHECKOUT_CREATE_FAILED",
        errorMessage: "Unable to create payment checkout",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
    return this.store.updateOrder({
      ...order,
      provider: providerResult.provider,
      status: "checkout_created",
      paymentStatus: "unpaid",
      externalCheckoutId: providerResult.externalCheckoutId,
      externalCustomerId: providerResult.externalCustomerId,
      externalProductId:
        providerResult.externalProductId ?? order.externalProductId,
      expiresAt: providerResult.expiresAt ?? order.expiresAt,
      metadata: {
        ...order.metadata,
        ...providerResult.metadata,
        checkoutUrl: providerResult.checkoutUrl,
      },
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    });
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
        previousCheckoutId: input.order.externalCheckoutId ?? undefined,
        kind: input.order.kind,
        teamId: input.order.teamId,
        actorUserId: input.actor.userId,
        actorEmail:
          typeof input.order.metadata.checkoutActorEmail === "string"
            ? input.order.metadata.checkoutActorEmail
            : input.actor.email,
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
      await this.store.runInTransaction(async (client) => {
        await this.store.lockSubscriptionTarget(
          String(input.order.metadata.subscriptionTarget),
          client,
        );
        const current = await this.store.getOrderByIdForUpdate(
          input.order.id,
          client,
        );
        if (current && current.paymentStatus !== "paid")
          await this.store.updateOrder(
            {
              ...current,
              status: "payment_failed",
              paymentStatus: "failed",
              errorCode: "BILLING_CHECKOUT_RESULT_UNKNOWN",
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "Checkout result is unresolved",
              updatedAt: new Date().toISOString(),
            },
            client,
          );
      });
      throw error;
    }
    return this.store.runInTransaction(async (client) => {
      await this.store.lockSubscriptionTarget(
        String(input.order.metadata.subscriptionTarget),
        client,
      );
      const current = await this.store.getOrderByIdForUpdate(
        input.order.id,
        client,
      );
      if (!current)
        throw new BillingError(
          "BILLING_ORDER_NOT_FOUND",
          404,
          "Order not found",
        );
      return this.store.updateOrder(
        {
          ...current,
          provider: providerResult.provider,
          status:
            current.paymentStatus === "paid"
              ? current.status
              : "checkout_created",
          paymentStatus: current.paymentStatus === "paid" ? "paid" : "unpaid",
          externalCheckoutId: providerResult.externalCheckoutId,
          externalCustomerId:
            providerResult.externalCustomerId ?? current.externalCustomerId,
          externalProductId:
            providerResult.externalProductId ?? current.externalProductId,
          expiresAt: providerResult.expiresAt ?? current.expiresAt,
          metadata: {
            ...current.metadata,
            ...providerResult.metadata,
            checkoutUrl: providerResult.checkoutUrl,
          },
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date().toISOString(),
        },
        client,
      );
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
        const observed = await this.store.getOrderById(input.orderId, client);
        if (observed?.kind === "subscription") {
          const team = observed.teamId ?? observed.metadata.existingTeamId;
          await this.store.lockSubscriptionTarget(
            typeof team === "string"
              ? `team:${team}`
              : `purchase:${observed.id}`,
            client,
          );
        }
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
              ...(input.currentPeriodStart
                ? { currentPeriodStart: input.currentPeriodStart }
                : {}),
              ...(input.currentPeriodEnd
                ? { currentPeriodEnd: input.currentPeriodEnd }
                : {}),
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

    const applied = await new BillingSubscriptionService(
      this.store,
      this.runtimeConfig,
      this.provider,
      this.accountService,
    ).applySubscriptionSnapshotLocked(
      { ...snapshot, confirmCoverage: true },
      client,
      true,
    );
    if (!applied)
      throw new BillingError(
        "SUBSCRIPTION_BINDING_CONFLICT",
        409,
        "This purchase no longer owns the current subscription",
      );
    await this.store.completeSubscriptionPurchase(order.id, client);

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
        grantAddOnCredits(account, grantAmount);
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
    if (typeof order.metadata.existingTeamId === "string")
      return order.metadata.existingTeamId;
    if (order.teamId) {
      return order.teamId;
    }

    const teamName =
      normalizeTeamName(order.metadata.teamName) || generateFallbackTeamName();
    if (!this.host)
      throw new BillingError(
        "BILLING_HOST_MISSING",
        500,
        "Organization provisioning host is required",
      );
    const metadata = {
      ...this.host.organizationMetadata("team"),
      sourceweft: {
        kind: "team",
        billingOrderId: order.id,
      },
    };
    const created = await this.host.createTeamOrganization({
      name: teamName,
      slug: `team-${order.id.slice(0, 8)}`,
      userId: order.userId,
      metadata,
      idempotencyKey: order.id,
    });

    if (created.created) {
      await this.host.ensureMembershipWorkspace({
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

    throw new BillingError(
      "INVALID_PROVIDER_SUBSCRIPTION_PERIOD",
      422,
      "A confirmed subscription period is required",
    );
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
