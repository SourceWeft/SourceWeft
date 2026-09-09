import type { BillingStore } from "./store-port";
import type {
  BillingRuntimeConfig,
  BillingWebhookProcessInput,
  BillingWebhookProcessResult,
} from "./types";
import { isBillingError } from "./errors";
import { BillingOrderService } from "./order-service";
import { BillingSubscriptionService } from "./subscription-service";
import {
  createFallbackWebhookEventId,
  toWebhookError,
} from "./service-helpers";

export class BillingWebhookService {
  constructor(
    private readonly store: BillingStore,
    private readonly runtimeConfig: BillingRuntimeConfig,
    private readonly subscriptionService: BillingSubscriptionService,
    private readonly orderService?: BillingOrderService,
  ) {}

  async processSubscriptionWebhookEvent(
    input: BillingWebhookProcessInput,
  ): Promise<BillingWebhookProcessResult> {
    const providerEventId =
      input.providerEventId?.trim() || createFallbackWebhookEventId(input);
    const payload = input.payload ?? {};
    const metadata = input.metadata ?? {};

    const existing = await this.store.getWebhookEventByProviderEventId(
      input.provider,
      providerEventId,
    );

    const webhookEvent = existing
      ? await this.store.incrementWebhookEventAttempt(existing.id, {
          eventType: input.eventType,
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          payload,
          metadata,
        })
      : await this.store.insertWebhookEvent({
          provider: input.provider,
          providerEventId,
          eventType: input.eventType,
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          payload,
          metadata,
        });

    if (webhookEvent.status === "processed") {
      return {
        outcome: "duplicate",
        webhookEvent,
        reason: "already_processed",
      };
    }

    if (
      !this.runtimeConfig.teamBillingEnabled &&
      input.snapshot?.planFamily === "team_standard" &&
      !input.orderFulfillment
    ) {
      const ignored = await this.store.updateWebhookEventState(
        webhookEvent.id,
        {
          status: "ignored",
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          processedAt: new Date().toISOString(),
          errorCode: "TEAM_BILLING_DISABLED",
          errorMessage:
            "Team billing is disabled, webhook was recorded without applying business sync",
        },
      );

      return {
        outcome: "ignored",
        webhookEvent: ignored,
        reason: "team_billing_disabled",
      };
    }

    if (!input.snapshot && !input.orderFulfillment) {
      const ignored = await this.store.updateWebhookEventState(
        webhookEvent.id,
        {
          status: "ignored",
          teamId: input.teamId,
          externalSubscriptionId: input.externalSubscriptionId,
          processedAt: new Date().toISOString(),
          errorCode: "WEBHOOK_CONTEXT_MISSING",
          errorMessage: "Cannot map webhook payload to a supported team plan",
        },
      );

      return {
        outcome: "ignored",
        webhookEvent: ignored,
        reason: "context_missing",
      };
    }

    try {
      if (input.orderFulfillment) {
        if (!this.orderService) {
          throw new Error("Billing order service is not configured");
        }

        await this.orderService.fulfillOrder(input.orderFulfillment);
      }

      if (input.snapshot) {
        await this.subscriptionService.syncSubscriptionSnapshot(input.snapshot);
      }

      const processed = await this.store.updateWebhookEventState(
        webhookEvent.id,
        {
          status: "processed",
          teamId: input.snapshot?.teamId ?? input.teamId,
          externalSubscriptionId:
            input.snapshot?.externalSubscriptionId ??
            input.orderFulfillment?.externalSubscriptionId ??
            input.externalSubscriptionId,
          processedAt: new Date().toISOString(),
          errorCode: null,
          errorMessage: null,
        },
      );

      return {
        outcome: "processed",
        webhookEvent: processed,
      };
    } catch (error) {
      const details = toWebhookError(error);
      if (
        isBillingError(error) &&
        error.code === "INVALID_PROVIDER_SUBSCRIPTION_PERIOD"
      ) {
        const ignored = await this.store.updateWebhookEventState(
          webhookEvent.id,
          {
            status: "ignored",
            teamId: input.snapshot?.teamId ?? input.teamId,
            externalSubscriptionId:
              input.snapshot?.externalSubscriptionId ??
              input.orderFulfillment?.externalSubscriptionId ??
              input.externalSubscriptionId,
            processedAt: new Date().toISOString(),
            errorCode: details.code,
            errorMessage: details.message,
          },
        );

        return {
          outcome: "ignored",
          webhookEvent: ignored,
          reason: "provider_period_invalid",
        };
      }

      await this.store.updateWebhookEventState(webhookEvent.id, {
        status: "failed",
        teamId: input.snapshot?.teamId ?? input.teamId,
        externalSubscriptionId:
          input.snapshot?.externalSubscriptionId ??
          input.orderFulfillment?.externalSubscriptionId ??
          input.externalSubscriptionId,
        processedAt: new Date().toISOString(),
        errorCode: details.code,
        errorMessage: details.message,
      });
      throw error;
    }
  }
}
