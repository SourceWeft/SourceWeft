import type { BillingSubscriptionStatus } from "@sourceweft/contracts";
import { createHash } from "node:crypto";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import type { opsAlertService } from "../../ops";
import type { BillingService } from "../service";
import type { TeamSubscriptionSnapshot } from "../types";

type CreemSubscriptionSyncDeps = {
  billing: BillingService;
  alerts: typeof opsAlertService;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function pickString(value: unknown, keys: string[]) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

function pickBoolean(value: unknown, keys: string[]) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  return null;
}

function pickDateIso(value: unknown, keys: string[]) {
  const text = pickString(value, keys);
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`,
    );

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}

function createFallbackWebhookEventId(input: {
  eventType: string;
  teamId: string | null;
  externalSubscriptionId: string | null;
  externalCustomerId: string | null;
  externalProductId: string | null;
  subscriptionStatus: BillingSubscriptionStatus | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  fallbackStatus: BillingSubscriptionStatus;
}) {
  const seed = {
    provider: "creem",
    eventType: input.eventType,
    teamId: input.teamId,
    externalSubscriptionId: input.externalSubscriptionId,
    externalCustomerId: input.externalCustomerId,
    externalProductId: input.externalProductId,
    subscriptionStatus: input.subscriptionStatus,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    fallbackStatus: input.fallbackStatus,
  };

  const digest = createHash("sha256")
    .update(stableSerialize(seed))
    .digest("hex")
    .slice(0, 32);

  return `fallback:${digest}`;
}

function resolveTeamId(
  metadata: Record<string, unknown> | null,
  data: unknown,
) {
  const fromMetadata = metadata?.teamId;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) {
    return fromMetadata;
  }

  return pickString(data, ["teamId"]);
}

function resolvePlanFamily(
  metadata: Record<string, unknown> | null,
  data: unknown,
): "team_standard" | null {
  if (metadata?.planFamily === "team_standard") {
    return "team_standard";
  }

  const product = asRecord(asRecord(data)?.product ?? null);
  const productId =
    pickString(data, ["productId", "creemProductId", "product_id"]) ||
    pickString(product, ["id", "productId"]);

  if (productId && productId === config.billing.creem.teamStandardProductId) {
    return "team_standard";
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

  if (normalized === "paid") {
    return "active";
  }

  return fallback;
}

function resolveCreemSeatCount(
  data: unknown,
  metadata: Record<string, unknown> | null,
): number {
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

  const record = asRecord(data);
  const items = record?.items;
  if (Array.isArray(items) && items.length > 0) {
    const firstItem = asRecord(items[0]);
    const units = parseSeatCount(firstItem?.units);
    if (units !== null) {
      return units;
    }
  }

  const metaSeatCount = parseSeatCount(metadata?.seatCount);
  if (metaSeatCount !== null) {
    return metaSeatCount;
  }

  return 2;
}

function buildCreemSubscriptionSnapshot(
  data: unknown,
  fallbackStatus: BillingSubscriptionStatus,
): TeamSubscriptionSnapshot | null {
  const metadata = asRecord(asRecord(data)?.metadata ?? null);
  const teamId = resolveTeamId(metadata, data);
  const planFamily = resolvePlanFamily(metadata, data);

  if (!teamId || !planFamily) {
    return null;
  }

  const customer = asRecord(asRecord(data)?.customer ?? null);
  const product = asRecord(asRecord(data)?.product ?? null);

  const externalCustomerId =
    pickString(data, ["creemCustomerId", "customerId", "customer_id"]) ||
    pickString(customer, ["id", "customerId"]) ||
    null;

  const externalSubscriptionId =
    pickString(data, [
      "creemSubscriptionId",
      "subscriptionId",
      "subscription_id",
    ]) || null;

  const externalProductId =
    pickString(data, ["productId", "creemProductId", "product_id"]) ||
    pickString(product, ["id", "productId"]) ||
    null;

  const status = normalizeSubscriptionStatus(
    pickString(data, ["status", "subscriptionStatus", "subscription_status"]),
    fallbackStatus,
  );

  return {
    teamId,
    provider: "creem",
    planFamily,
    status,
    currentPeriodStart: pickDateIso(data, [
      "currentPeriodStart",
      "current_period_start",
      "periodStart",
      "current_period_start_date",
    ]),
    currentPeriodEnd: pickDateIso(data, [
      "currentPeriodEnd",
      "current_period_end",
      "periodEnd",
      "current_period_end_date",
      "next_billing_date",
    ]),
    externalCustomerId,
    externalSubscriptionId,
    externalProductId,
    cancelAtPeriodEnd:
      pickBoolean(data, ["cancelAtPeriodEnd", "cancel_at_period_end"]) ?? false,
    metadata: metadata ?? {},
    seatCount: resolveCreemSeatCount(data, metadata),
  };
}

export function createCreemSubscriptionSync(deps: CreemSubscriptionSyncDeps) {
  return async function syncCreemSubscriptionEvent(
    eventType: string,
    data: unknown,
    fallbackStatus: BillingSubscriptionStatus,
  ) {
  const payload = asRecord(data) ?? {
    raw: data,
  };
  const snapshot = buildCreemSubscriptionSnapshot(data, fallbackStatus);

  const rawProviderEventId = pickString(data, [
    "eventId",
    "event_id",
    "webhookId",
    "webhook_id",
    "requestId",
    "request_id",
  ]);

  const externalSubscriptionId =
    snapshot?.externalSubscriptionId ||
    pickString(data, [
      "creemSubscriptionId",
      "subscriptionId",
      "subscription_id",
    ]);

  const teamId =
    snapshot?.teamId || resolveTeamId(asRecord(payload.metadata), data);

  const providerEventId =
    rawProviderEventId ||
    createFallbackWebhookEventId({
      eventType,
      teamId: teamId ?? null,
      externalSubscriptionId: externalSubscriptionId ?? null,
      externalCustomerId: snapshot?.externalCustomerId ?? null,
      externalProductId: snapshot?.externalProductId ?? null,
      subscriptionStatus: snapshot?.status ?? fallbackStatus,
      currentPeriodStart: snapshot?.currentPeriodStart ?? null,
      currentPeriodEnd: snapshot?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd ?? false,
      fallbackStatus,
    });

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
          alertError instanceof Error ? alertError.message : String(alertError),
      });
    }
  }

  try {
    if (!rawProviderEventId) {
      await triggerAlertSafely({
        alertKey: `billing:webhook:missing-event-id:${eventType}:${teamId || "unknown"}`,
        level: "warn",
        source: "billing.webhook",
        title: "Subscription webhook missing provider event id",
        message:
          "Provider webhook did not include an event id; fallback dedupe key was generated",
        teamId: teamId ?? null,
        metadata: {
          eventType,
          generatedProviderEventId: providerEventId,
          fallbackStatus,
        },
      });
    }

    const result = await deps.billing.processSubscriptionWebhookEvent({
      provider: "creem",
      providerEventId,
      eventType,
      payload,
      teamId: teamId ?? null,
      externalSubscriptionId: externalSubscriptionId ?? null,
      metadata: {
        fallbackStatus,
      },
      snapshot,
    });

    if (result.outcome === "ignored") {
      const ignoreReason = result.reason || "unknown";
      const ignoreMessages: Record<string, string> = {
        context_missing:
          "Webhook ignored due to missing team/plan mapping in provider payload",
        team_billing_disabled:
          "Webhook recorded but business sync skipped because team billing is disabled",
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
