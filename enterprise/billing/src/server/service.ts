import { BillingError } from "./errors";
import type { BillingServiceHost } from "./host";
import type {
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreatePricingCheckoutRequest,
  CreatePricingCheckoutResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
  CreateTopupCheckoutRequest,
  CreateTopupCheckoutResponse,
  MeterConsumeRequest,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
  PreviewTeamSubscriptionSeatsResponse,
  UpdateTeamSubscriptionSeatsRequest,
  UpdateTeamSubscriptionSeatsResponse,
  UpdateSpendLimitsRequest,
  UpdateSpendLimitsResponse,
} from "@sourceweft/contracts";
import { BillingAccountService } from "./account-service";
import { BillingOrderService } from "./order-service";
import { BillingReconcileService } from "./reconcile-service";
import { BillingSubscriptionService } from "./subscription-service";
import type { BillingStore } from "./store-port";
import type {
  BillingProviderAdapter,
  BillingOrderState,
  BillingRuntimeConfig,
  BillingWebhookProcessInput,
  BillingWebhookProcessResult,
  TeamSubscriptionSnapshot,
} from "./types";
import { BillingUsageService } from "./usage-service";
import { BillingWebhookService } from "./webhook-service";

export class BillingService {
  private readonly accountService: BillingAccountService;
  private readonly orderService: BillingOrderService;
  private readonly usageService: BillingUsageService;
  private readonly subscriptionService: BillingSubscriptionService;
  private readonly webhookService: BillingWebhookService;
  private readonly reconcileService: BillingReconcileService;

  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    provider: BillingProviderAdapter,
    alerts?: ConstructorParameters<typeof BillingSubscriptionService>[4],
    host?: BillingServiceHost,
  ) {
    this.accountService = new BillingAccountService(store, runtimeConfig);
    this.orderService = new BillingOrderService(
      store,
      runtimeConfig,
      provider,
      this.accountService,
      alerts,
      host,
    );
    this.usageService = new BillingUsageService(
      store,
      runtimeConfig,
      this.accountService,
      this.orderService,
    );
    this.subscriptionService = new BillingSubscriptionService(
      store,
      runtimeConfig,
      provider,
      this.accountService,
      alerts,
      host?.logger,
    );
    this.webhookService = new BillingWebhookService(
      store,
      runtimeConfig,
      this.subscriptionService,
      this.orderService,
    );
    this.reconcileService = new BillingReconcileService(
      store,
      runtimeConfig,
      this.accountService,
    );
  }

  ensureBillingAccount(teamId: string, userId: string) {
    return this.usageService.ensureBillingAccount(teamId, userId);
  }

  getSummary(teamId: string, userId: string) {
    return this.usageService.getSummary(teamId, userId);
  }

  getUsage(teamId: string, userId: string) {
    return this.usageService.getUsage(teamId, userId);
  }

  getLedger(
    teamId: string,
    limit = 50,
    options?: {
      activityOnly?: boolean;
      actorUserId?: string;
      cursor?: { createdAt: Date; id: string } | null;
    },
  ) {
    return this.usageService.getLedger(teamId, limit, options);
  }

  getSubscription(teamId: string) {
    return this.subscriptionService.getSubscription(teamId);
  }

  async getSubscriptionWebhookContext(
    provider: TeamSubscriptionSnapshot["provider"],
    externalSubscriptionId: string,
  ) {
    const subscription = await this.store.getSubscriptionByProviderSubscription(
      provider,
      externalSubscriptionId,
    );
    // A representative member row carries the team-level attributes the webhook
    // context needs (plan, cycle); balances are per-member and not read here.
    const account = subscription
      ? await this.store.getAnyTeamAccount(subscription.teamId)
      : null;

    return { account, subscription };
  }

  createSubscriptionCheckout(
    teamId: string,
    input: CreateTeamSubscriptionCheckoutRequest,
    actor: { userId: string; email: string },
  ): Promise<CreateTeamSubscriptionCheckoutResponse> {
    return this.orderService
      .createPricingCheckout({
        request: {
          plan: input.planFamily === "individual_pro" ? "pro" : "team",
          billingInterval: input.billingInterval,
          source: "dashboard",
          seatCount: input.seatCount,
          successUrl: input.successUrl,
        },
        actor,
        ...(input.planFamily === "individual_pro"
          ? { personalTeamId: teamId }
          : { existingTeamId: teamId }),
      })
      .then((order) => ({
        teamId,
        provider: order.provider,
        checkoutUrl: order.checkoutUrl,
      }));
  }

  createPricingCheckout(
    input: CreatePricingCheckoutRequest,
    actor: { userId: string; email: string },
    options?: { personalTeamId?: string | null },
  ): Promise<CreatePricingCheckoutResponse> {
    return this.orderService.createPricingCheckout({
      request: input,
      actor,
      personalTeamId: options?.personalTeamId,
    });
  }

  getOrder(orderId: string): Promise<BillingOrderState | null> {
    return this.orderService.getOrder(orderId);
  }

  fulfillOrder(input: Parameters<BillingOrderService["fulfillOrder"]>[0]) {
    return this.orderService.fulfillOrder(input);
  }

  createBillingPortal(
    teamId: string,
    actorUserId: string,
  ): Promise<CreateTeamBillingPortalResponse> {
    return this.subscriptionService.createBillingPortal(teamId, actorUserId);
  }

  cancelSubscription(
    teamId: string,
    actorUserId: string,
  ): Promise<CancelTeamSubscriptionResponse> {
    return this.subscriptionService.cancelSubscription(teamId, actorUserId);
  }

  /** Internal operator integration only; no tenant HTTP route exposes this command. */
  grantManualSubscription(
    snapshot: TeamSubscriptionSnapshot,
    operator: { userId: string; canGrantBilling: boolean },
    operationId: string,
  ) {
    if (
      !operator.canGrantBilling ||
      !operator.userId ||
      !operationId ||
      snapshot.provider !== "manual"
    )
      throw new BillingError(
        "MANUAL_SUBSCRIPTION_AUTHORIZATION_REQUIRED",
        403,
        "Explicit operator billing authorization is required",
      );
    return this.store.runInTransaction((client) =>
      this.subscriptionService.applySubscriptionSnapshotLocked(
        {
          ...snapshot,
          billingOrderId: operationId,
          confirmCoverage: true,
          metadata: { ...snapshot.metadata, authorizedBy: operator.userId },
        },
        client,
        true,
      ),
    );
  }

  syncSubscriptionSnapshot(snapshot: TeamSubscriptionSnapshot) {
    return this.subscriptionService.syncSubscriptionSnapshot(snapshot);
  }

  assertCanInviteTeamMember(teamId: string) {
    return this.subscriptionService.assertCanInviteTeamMember(teamId);
  }

  assertCanAcceptTeamInvitation(teamId: string) {
    return this.subscriptionService.assertCanAcceptTeamInvitation(teamId);
  }

  assertCanAddTeamMember(teamId: string) {
    return this.subscriptionService.assertCanAddTeamMember(teamId);
  }

  previewTeamSubscriptionSeats(
    teamId: string,
    input: UpdateTeamSubscriptionSeatsRequest,
  ): Promise<PreviewTeamSubscriptionSeatsResponse> {
    return this.subscriptionService.previewTeamSubscriptionSeats(teamId, input);
  }

  syncTeamSubscriptionSeats(
    teamId: string,
    input: UpdateTeamSubscriptionSeatsRequest & {
      actorUserId?: string | null;
      reason?: string;
    },
  ): Promise<UpdateTeamSubscriptionSeatsResponse> {
    return this.subscriptionService.syncTeamSubscriptionSeats(teamId, input);
  }

  syncTeamSubscriptionSeatsToMembers(
    teamId: string,
    input?: {
      actorUserId?: string | null;
      reason?: string;
    },
  ) {
    return this.subscriptionService.syncTeamSubscriptionSeatsToMembers(
      teamId,
      input,
    );
  }

  processSubscriptionWebhookEvent(
    input: BillingWebhookProcessInput,
  ): Promise<BillingWebhookProcessResult> {
    return this.webhookService.processSubscriptionWebhookEvent(input);
  }

  reconcileTeamSubscriptions() {
    return this.reconcileService.reconcileTeamSubscriptions();
  }

  reconcileBillingOrders() {
    return this.orderService.reconcileRetryableOrders();
  }

  updateSpendLimits(
    teamId: string,
    input: UpdateSpendLimitsRequest,
  ): Promise<UpdateSpendLimitsResponse> {
    return this.accountService.updateSpendLimits(teamId, input);
  }

  createTopupCheckout(
    teamId: string,
    input: CreateTopupCheckoutRequest,
    actorUserId?: string,
    actorEmail?: string,
  ): Promise<CreateTopupCheckoutResponse> {
    return this.usageService.createTopupCheckout(
      teamId,
      input,
      actorUserId,
      actorEmail,
    );
  }

  meterConsume(
    teamId: string,
    input: MeterConsumeRequest,
    actorUserId: string,
  ): Promise<MeterConsumeResponse> {
    return this.usageService.meterConsume(teamId, input, actorUserId);
  }

  reconcileModelProviderCost(
    input: Parameters<BillingUsageService["reconcileModelProviderCost"]>[0],
  ) {
    return this.usageService.reconcileModelProviderCost(input);
  }

  meterIngestion(
    teamId: string,
    input: MeterIngestionRequest,
    actorUserId: string,
  ): Promise<MeterIngestionResponse> {
    return this.usageService.meterIngestion(teamId, input, actorUserId);
  }
}
