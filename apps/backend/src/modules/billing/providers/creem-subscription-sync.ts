import type { BillingSubscriptionStatus } from "@sourceweft/contracts";
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

function resolvePlanFamily(
  metadata: Record<string, unknown> | null,
  data: unknown,
): "team_standard" | null {
  if (metadata?.planFamily === "team_standard") {
    return "team_standard";
  }

  const product = asRecord(asRecord(data)?.product ?? null);
  const productId = readString(product, "id");

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

  if (normalized === "paid" || normalized === "scheduled_cancel") {
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

  throw new Error("Unable to resolve Creem subscription seat count");
}

function buildCreemSubscriptionSnapshot(
  data: unknown,
  fallbackStatus: BillingSubscriptionStatus,
): TeamSubscriptionSnapshot | null {
  const record = asRecord(data);
  const metadata = asRecord(record?.metadata ?? null);
  const teamId = resolveTeamId(metadata);
  const planFamily = resolvePlanFamily(metadata, data);

  if (!teamId || !planFamily) {
    return null;
  }

  const customer = asRecord(record?.customer ?? null);
  const product = asRecord(record?.product ?? null);
  const rawStatus = readString(record, "status");

  return {
    teamId,
    provider: "creem",
    planFamily,
    status: normalizeSubscriptionStatus(rawStatus, fallbackStatus),
    currentPeriodStart: toDateIso(record?.current_period_start_date),
    currentPeriodEnd: toDateIso(record?.current_period_end_date),
    externalCustomerId: readString(customer, "id"),
    externalSubscriptionId: readString(record, "id"),
    externalProductId: readString(product, "id"),
    cancelAtPeriodEnd: rawStatus === "scheduled_cancel",
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
    const record = asRecord(data);
    const payload = record ?? {
      raw: data,
    };
    const snapshot = buildCreemSubscriptionSnapshot(data, fallbackStatus);
    const providerEventId = readString(record, "webhookId");
    const externalSubscriptionId =
      snapshot?.externalSubscriptionId || readString(record, "id");
    const teamId = snapshot?.teamId || resolveTeamId(asRecord(payload.metadata));

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
