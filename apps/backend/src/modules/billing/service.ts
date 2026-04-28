import type {
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
  CreateTopupCheckoutRequest,
  CreateTopupCheckoutResponse,
  MeterConsumeRequest,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
  UpdateSpendLimitsRequest,
  UpdateSpendLimitsResponse,
} from "@sourceweft/contracts";
import { BillingAccountService } from "./account-service";
import { BillingReconcileService } from "./reconcile-service";
import { BillingSubscriptionService } from "./subscription-service";
import type { BillingStore } from "./store-port";
import type {
  BillingProviderAdapter,
  BillingRuntimeConfig,
  BillingWebhookProcessInput,
  BillingWebhookProcessResult,
  TeamSubscriptionSnapshot,
} from "./types";
import { BillingUsageService } from "./usage-service";
import { BillingWebhookService } from "./webhook-service";

export class BillingService {
  private readonly accountService: BillingAccountService;
  private readonly usageService: BillingUsageService;
  private readonly subscriptionService: BillingSubscriptionService;
  private readonly webhookService: BillingWebhookService;
  private readonly reconcileService: BillingReconcileService;

  constructor(
    store: BillingStore,
    runtimeConfig: BillingRuntimeConfig,
    provider: BillingProviderAdapter,
  ) {
    this.accountService = new BillingAccountService(store, runtimeConfig);
    this.usageService = new BillingUsageService(
      store,
      runtimeConfig,
      this.accountService,
    );
    this.subscriptionService = new BillingSubscriptionService(
      store,
      runtimeConfig,
      provider,
      this.accountService,
    );
    this.webhookService = new BillingWebhookService(
      store,
      runtimeConfig,
      this.subscriptionService,
    );
    this.reconcileService = new BillingReconcileService(
      store,
      runtimeConfig,
      this.accountService,
    );
  }

  ensureBillingAccount(teamId: string) {
    return this.usageService.ensureBillingAccount(teamId);
  }

  getSummary(teamId: string) {
    return this.usageService.getSummary(teamId);
  }

  getUsage(teamId: string) {
    return this.usageService.getUsage(teamId);
  }

  getLedger(teamId: string, limit = 50) {
    return this.usageService.getLedger(teamId, limit);
  }

  getSubscription(teamId: string) {
    return this.subscriptionService.getSubscription(teamId);
  }

  createSubscriptionCheckout(
    teamId: string,
    input: CreateTeamSubscriptionCheckoutRequest,
    actor: { userId: string; email: string },
  ): Promise<CreateTeamSubscriptionCheckoutResponse> {
    return this.subscriptionService.createSubscriptionCheckout(
      teamId,
      input,
      actor,
    );
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

  syncSubscriptionSnapshot(snapshot: TeamSubscriptionSnapshot) {
    return this.subscriptionService.syncSubscriptionSnapshot(snapshot);
  }

  processSubscriptionWebhookEvent(
    input: BillingWebhookProcessInput,
  ): Promise<BillingWebhookProcessResult> {
    return this.webhookService.processSubscriptionWebhookEvent(input);
  }

  reconcileTeamSubscriptions() {
    return this.reconcileService.reconcileTeamSubscriptions();
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
  ): Promise<CreateTopupCheckoutResponse> {
    return this.usageService.createTopupCheckout(teamId, input, actorUserId);
  }

  meterConsume(
    teamId: string,
    input: MeterConsumeRequest,
    actorUserId: string,
  ): Promise<MeterConsumeResponse> {
    return this.usageService.meterConsume(teamId, input, actorUserId);
  }

  meterIngestion(
    teamId: string,
    input: MeterIngestionRequest,
    actorUserId: string,
  ): Promise<MeterIngestionResponse> {
    return this.usageService.meterIngestion(teamId, input, actorUserId);
  }
}
