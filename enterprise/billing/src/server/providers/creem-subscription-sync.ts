import type {
  BillingInterval,
  BillingSubscriptionStatus,
} from "@sourceweft/contracts";
import type { BillingLogger, BillingAlertSink } from "../host";
import type { BillingRuntimeConfig } from "../types";
import type { BillingService } from "../service";
import type {
  BillingAccountState,
  BillingSubscriptionState,
  TeamSubscriptionSnapshot,
} from "../types";
import { toObjectRecord } from "../records";

type CreemSubscriptionSyncDeps = {
  billing: BillingService;
  alerts: BillingAlertSink;
  config: BillingRuntimeConfig;
  logger: BillingLogger;
};

type SubscriptionWebhookContext = {
  account: BillingAccountState | null;
  subscription: BillingSubscriptionState | null;
};

export function createCreemSubscriptionSync(deps: CreemSubscriptionSyncDeps) {
  const config = { billing: deps.config };
  const logger = deps.logger;

  function readString(record: Record<string, unknown> | null, key: string) {
    const value = record?.[key];
    return typeof value === "string" && value.trim() ? value : null;
  }

  function toDateIso(value: unknown) {
    const parsed =
      value instanceof Date
        ? value
        : typeof value === "number"
          ? new Date(value < 1_000_000_000_000 ? value * 1000 : value)
          : typeof value === "string" && value.trim()
            ? new Date(value)
            : null;

    if (!parsed || Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString();
  }

  function resolveTeamId(metadata: Record<string, unknown> | null) {
    const fromMetadata = metadata?.teamId;
    if (typeof fromMetadata === "string" && fromMetadata.trim()) {
      return fromMetadata;
    }

    return null;
  }

  function resolveOrderId(metadata: Record<string, unknown> | null) {
    const fromMetadata = metadata?.orderId;
    if (typeof fromMetadata === "string" && fromMetadata.trim()) {
      return fromMetadata;
    }

    return null;
  }

  function resolveMetadata(record: Record<string, unknown> | null) {
    const metadata = toObjectRecord(record?.metadata ?? null);
    if (metadata) {
      return metadata;
    }

    const subscription = toObjectRecord(record?.subscription ?? null);
    return toObjectRecord(subscription?.metadata ?? null);
  }

  function resolvePlanFamily(
    metadata: Record<string, unknown> | null,
    data: unknown,
  ): "individual_pro" | "team_standard" | null {
    if (
      metadata?.planFamily === "individual_pro" ||
      metadata?.planFamily === "team_standard"
    ) {
      return metadata.planFamily;
    }

    const product = toObjectRecord(toObjectRecord(data)?.product ?? null);
    const productId =
      readString(product, "id") ?? readString(toObjectRecord(data), "product");

    if (
      productId &&
      (productId === config.billing.creem.teamStandardMonthlyProductId ||
        productId === config.billing.creem.teamStandardYearlyProductId)
    ) {
      return "team_standard";
    }

    if (
      productId &&
      (productId === config.billing.creem.individualProMonthlyProductId ||
        productId === config.billing.creem.individualProYearlyProductId)
    ) {
      return "individual_pro";
    }

    return null;
  }

  function resolveBillingIntervalFromProduct(
    metadata: Record<string, unknown> | null,
    data: unknown,
  ): Exclude<BillingInterval, "unknown"> | null {
    if (metadata?.billingInterval === "monthly") {
      return "monthly";
    }

    if (metadata?.billingInterval === "yearly") {
      return "yearly";
    }

    const product = toObjectRecord(toObjectRecord(data)?.product ?? null);
    const productId =
      readString(product, "id") ?? readString(toObjectRecord(data), "product");
    if (!productId) {
      return null;
    }

    if (
      productId === config.billing.creem.individualProMonthlyProductId ||
      productId === config.billing.creem.teamStandardMonthlyProductId
    ) {
      return "monthly";
    }

    if (
      productId === config.billing.creem.individualProYearlyProductId ||
      productId === config.billing.creem.teamStandardYearlyProductId
    ) {
      return "yearly";
    }

    return null;
  }

  function normalizeSubscriptionStatus(
    value: string | null,
    fallback: BillingSubscriptionStatus,
  ): BillingSubscriptionStatus {
    if (!value) {
      return fallback;
    }

    const normalized = value.trim().toLowerCase();
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

    if (allowed.has(normalized as BillingSubscriptionStatus)) {
      return normalized as BillingSubscriptionStatus;
    }

    if (normalized === "paid" || normalized === "scheduled_cancel") {
      return "active";
    }

    return fallback;
  }

  function resolveStatusFromEventType(
    eventType: string,
  ): BillingSubscriptionStatus | null {
    switch (eventType) {
      case "subscription.active":
      case "subscription.paid":
        return "active";
      case "subscription.trialing":
        return "trialing";
      case "subscription.past_due":
        return "past_due";
      case "subscription.scheduled_cancel":
      case "subscription.update":
        return null;
      case "subscription.paused":
        return "paused";
      case "subscription.unpaid":
        return "unpaid";
      case "subscription.canceled":
        return "canceled";
      case "subscription.expired":
        return "expired";
      default:
        return null;
    }
  }

  function resolveCreemSubscriptionStatus(input: {
    eventType: string;
    rawStatus: string | null;
    fallbackStatus: BillingSubscriptionStatus;
  }) {
    return (
      resolveStatusFromEventType(input.eventType) ??
      normalizeSubscriptionStatus(input.rawStatus, input.fallbackStatus)
    );
  }

  function inferBillingInterval(
    currentPeriodStart: string | null,
    currentPeriodEnd: string | null,
  ): BillingInterval {
    if (!currentPeriodStart || !currentPeriodEnd) {
      return "unknown";
    }

    const startAt = Date.parse(currentPeriodStart);
    const endAt = Date.parse(currentPeriodEnd);
    if (
      !Number.isFinite(startAt) ||
      !Number.isFinite(endAt) ||
      endAt <= startAt
    ) {
      return "unknown";
    }

    const durationDays = (endAt - startAt) / 86_400_000;
    if (durationDays >= 300 && durationDays <= 370) {
      return "yearly";
    }

    if (durationDays >= 20 && durationDays <= 45) {
      return "monthly";
    }

    return "unknown";
  }

  function resolveCreemSeatCount(
    data: unknown,
    metadata: Record<string, unknown> | null,
    planFamily: "individual_pro" | "team_standard",
  ): number {
    if (planFamily === "individual_pro") {
      return 1;
    }

    const parseSeatCount = (value: unknown) => {
      const parsed =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? Number(value.trim())
            : NaN;

      if (Number.isFinite(parsed) && parsed >= 2) {
        return Math.floor(parsed);
      }

      return null;
    };

    const record = toObjectRecord(data);
    const items = record?.items;
    if (Array.isArray(items) && items.length > 0) {
      const firstItem = toObjectRecord(items[0]);
      const units = parseSeatCount(firstItem?.units);
      if (units !== null) {
        return units;
      }
    }

    const metaSeatCount = parseSeatCount(metadata?.seatCount);
    if (metaSeatCount !== null) {
      return metaSeatCount;
    }

    throw new Error("Unable to resolve Creem subscription seat count");
  }

  function resolveCreemSeatCountWithFallback(
    data: unknown,
    metadata: Record<string, unknown> | null,
    planFamily: "individual_pro" | "team_standard",
    context?: SubscriptionWebhookContext | null,
  ) {
    try {
      return resolveCreemSeatCount(data, metadata, planFamily);
    } catch (error) {
      if (planFamily === "team_standard" && context?.account) {
        return context.account.seatCount;
      }

      throw error;
    }
  }

  function resolveSubscriptionItemId(data: unknown) {
    const record = toObjectRecord(data);
    const items = record?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const firstItem = toObjectRecord(items[0]);
    return readString(firstItem, "id");
  }

  function buildCreemSubscriptionSnapshot(
    eventType: string,
    data: unknown,
    fallbackStatus: BillingSubscriptionStatus,
    context?: SubscriptionWebhookContext | null,
  ): TeamSubscriptionSnapshot | null {
    const record = toObjectRecord(data);
    const metadata = resolveMetadata(record);
    const teamId = resolveTeamId(metadata) ?? context?.subscription?.teamId;
    const planFamily =
      resolvePlanFamily(metadata, data) ??
      (context?.subscription?.planFamily === "individual_pro" ||
      context?.subscription?.planFamily === "team_standard"
        ? context.subscription.planFamily
        : null);

    if (!planFamily || (planFamily === "individual_pro" && !teamId)) {
      return null;
    }

    if (planFamily === "team_standard" && !teamId) {
      return null;
    }

    const resolvedTeamId = teamId;
    if (!resolvedTeamId) {
      return null;
    }

    const customer = toObjectRecord(record?.customer ?? null);
    const product = toObjectRecord(record?.product ?? null);
    const customerId =
      readString(customer, "id") ??
      readString(record, "customer") ??
      context?.subscription?.externalCustomerId ??
      null;
    const productId =
      readString(product, "id") ??
      readString(record, "product") ??
      context?.subscription?.externalProductId ??
      null;
    const rawStatus = readString(record, "status");
    const currentPeriodStart =
      toDateIso(
        record?.current_period_start_date ?? record?.currentPeriodStartDate,
      ) ??
      context?.subscription?.currentPeriodStart ??
      null;
    const currentPeriodEnd =
      toDateIso(
        record?.current_period_end_date ?? record?.currentPeriodEndDate,
      ) ??
      context?.subscription?.currentPeriodEnd ??
      null;
    const billingInterval =
      resolveBillingIntervalFromProduct(metadata, data) ??
      (context?.subscription?.billingInterval === "monthly" ||
      context?.subscription?.billingInterval === "yearly"
        ? context.subscription.billingInterval
        : null) ??
      inferBillingInterval(currentPeriodStart, currentPeriodEnd);
    const externalSubscriptionId: string | null =
      readString(record, "id") ??
      context?.subscription?.externalSubscriptionId ??
      null;

    return {
      teamId: resolvedTeamId,
      provider: "creem",
      planFamily,
      status: resolveCreemSubscriptionStatus({
        eventType,
        rawStatus,
        fallbackStatus,
      }),
      billingInterval,
      currentPeriodStart,
      currentPeriodEnd,
      externalCustomerId: customerId,
      externalSubscriptionId,
      externalProductId: productId,
      cancelAtPeriodEnd:
        rawStatus === "scheduled_cancel" ||
        record?.cancel_at_period_end === true ||
        eventType === "subscription.scheduled_cancel",
      metadata: metadata ?? {},
      seatCount: resolveCreemSeatCountWithFallback(
        data,
        metadata,
        planFamily,
        context,
      ),
      billingOrderId:
        resolveOrderId(metadata) ?? context?.subscription?.billingOrderId,
      externalSubscriptionItemId:
        resolveSubscriptionItemId(data) ??
        context?.subscription?.externalSubscriptionItemId,
    };
  }

  return async function syncCreemSubscriptionEvent(
    eventType: string,
    data: unknown,
    fallbackStatus: BillingSubscriptionStatus,
  ) {
    const record = toObjectRecord(data);
    const payload = record ?? {
      raw: data,
    };
    const providerEventId = readString(record, "webhookId");
    const rawExternalSubscriptionId = readString(record, "id");
    const context = rawExternalSubscriptionId
      ? await deps.billing.getSubscriptionWebhookContext(
          "creem",
          rawExternalSubscriptionId,
        )
      : null;
    const snapshot = buildCreemSubscriptionSnapshot(
      eventType,
      data,
      fallbackStatus,
      context,
    );
    const metadata = resolveMetadata(record);
    const orderId = resolveOrderId(metadata);
    const externalSubscriptionId =
      snapshot?.externalSubscriptionId || rawExternalSubscriptionId;
    const teamId =
      snapshot?.teamId || resolveTeamId(toObjectRecord(payload.metadata));

    async function triggerAlertSafely(
      input: Parameters<typeof deps.alerts.trigger>[0],
    ) {
      try {
        await deps.alerts.trigger(input);
      } catch (alertError) {
        logger.error("Failed to emit ops alert for billing webhook", {
          eventType,
          alertKey: input.alertKey,
          error:
            alertError instanceof Error
              ? alertError.message
              : String(alertError),
        });
      }
    }

    try {
      const result = await deps.billing.processSubscriptionWebhookEvent({
        provider: "creem",
        providerEventId,
        eventType,
        payload,
        teamId: teamId ?? null,
        externalSubscriptionId: externalSubscriptionId ?? null,
        metadata: {
          fallbackStatus,
          ...(metadata ?? {}),
        },
        snapshot,
        orderFulfillment: orderId
          ? {
              orderId,
              externalCustomerId: snapshot?.externalCustomerId ?? null,
              externalSubscriptionId: externalSubscriptionId ?? null,
              externalSubscriptionItemId:
                snapshot?.externalSubscriptionItemId ?? null,
              externalProductId: snapshot?.externalProductId ?? null,
              currentPeriodStart: snapshot?.currentPeriodStart ?? null,
              currentPeriodEnd: snapshot?.currentPeriodEnd ?? null,
              status: snapshot?.status ?? fallbackStatus,
              metadata: {
                fallbackStatus,
                ...(metadata ?? {}),
              },
            }
          : null,
      });

      if (result.outcome === "ignored") {
        const ignoreReason = result.reason || "unknown";
        const ignoreMessages: Record<string, string> = {
          context_missing:
            "Webhook ignored due to missing team/plan mapping in provider payload",
          team_billing_disabled:
            "Webhook recorded but business sync skipped because team billing is disabled",
          provider_period_invalid:
            "Webhook ignored because the active subscription period is missing or expired",
        };

        await triggerAlertSafely({
          alertKey: `billing:webhook:ignored:${eventType}:${teamId || "unknown"}`,
          level: "warn",
          source: "billing.webhook",
          title: "Subscription webhook ignored",
          message:
            ignoreMessages[ignoreReason] ||
            `Webhook ignored for event ${eventType} (${ignoreReason})`,
          teamId: teamId ?? null,
          metadata: {
            fallbackStatus,
            providerEventId,
            reason: ignoreReason,
          },
        });
        return;
      }

      if (result.outcome === "duplicate") {
        logger.info("Ignored duplicate creem webhook event", {
          eventType,
          providerEventId,
          teamId: teamId ?? null,
        });
        return;
      }

      await deps.alerts
        .resolve(`billing:webhook:failed:${eventType}:${teamId || "unknown"}`)
        .catch(() => null);
      await deps.alerts
        .resolve(`billing:webhook:ignored:${eventType}:${teamId || "unknown"}`)
        .catch(() => null);
    } catch (error) {
      await triggerAlertSafely({
        alertKey: `billing:webhook:failed:${eventType}:${teamId || "unknown"}`,
        level: "error",
        source: "billing.webhook",
        title: "Subscription webhook processing failed",
        message:
          error instanceof Error
            ? error.message
            : "Unknown webhook processing error",
        teamId: teamId ?? null,
        metadata: {
          eventType,
          providerEventId,
          fallbackStatus,
          externalSubscriptionId,
        },
      });

      logger.error("Failed to sync creem subscription event", {
        eventType,
        providerEventId,
        teamId: teamId ?? null,
        status: snapshot?.status,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

export { createCreemScheduledCancelWebhook } from "./creem-webhook-bypass";
