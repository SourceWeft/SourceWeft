import { validateWebhookSignature } from "@creem_io/better-auth/server";
import type { BillingRuntimeConfig, TeamSubscriptionSnapshot } from "../types";
import type { BillingLogger, BillingAlertSink } from "../host";
import type { createCreemSubscriptionSync } from "./creem-subscription-sync";
import { toObjectRecord } from "../records";

// Refund and dispute events are not processed automatically: money has
// already moved and a human needs to look at the Creem dashboard. We
// acknowledge these (200) so Creem stops retrying, but raise an alert
// instead of feeding them through the subscription sync.
const REVERSAL_EVENT_TYPES = new Set(["refund.created", "dispute.created"]);

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

// Creem's `order` reference shows up as either a bare id or an embedded
// object with its own `id`, depending on the event.
function readOrderId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return readString(toObjectRecord(value), "id");
}

function collectReversalMetadata(
  object: Record<string, unknown>,
  identifiers: {
    eventType: string;
    webhookId: string | null;
    objectId: string | null;
  },
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...identifiers };

  const status = readString(object, "status");
  if (status) metadata.status = status;

  const amount =
    readNumber(object, "refund_amount") ?? readNumber(object, "amount");
  if (amount !== null) metadata.amount = amount;

  const currency =
    readString(object, "refund_currency") ?? readString(object, "currency");
  if (currency) metadata.currency = currency;

  const transactionId = readString(object, "transaction");
  if (transactionId) metadata.transactionId = transactionId;

  const orderId = readOrderId(object.order);
  if (orderId) metadata.orderId = orderId;

  return metadata;
}

function failure(
  logger: BillingLogger,
  message: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  logger.error(message, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
  return Response.json({ error: "Failed to process webhook" }, { status: 500 });
}

function flattenCreemEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const object = toObjectRecord(event.object);
  if (!object) {
    return null;
  }

  return {
    ...object,
    webhookEventType: event.eventType,
    webhookId: event.id,
    webhookCreatedAt: event.created_at,
  };
}

export function createCreemWebhookHandler(deps: {
  config: BillingRuntimeConfig;
  logger: BillingLogger;
  alerts: BillingAlertSink;
  sync: ReturnType<typeof createCreemSubscriptionSync>;
}) {
  const config = { billing: deps.config };
  const logger = deps.logger;
  const alerts = deps.alerts;
  const syncCreemSubscriptionEvent = deps.sync;
  return async function handleCreemWebhook(request: Request) {
    if (
      config.billing.provider !== "creem" ||
      new URL(request.url).pathname !== "/api/auth/creem/webhook"
    ) {
      return null;
    }

    if (request.method !== "POST")
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );

    const rawBody = await request.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return Response.json(
        { error: "Invalid webhook payload" },
        { status: 400 },
      );
    }

    const event = toObjectRecord(parsed);
    if (!event) {
      return Response.json(
        { error: "Invalid webhook payload" },
        { status: 400 },
      );
    }

    if (!config.billing.creem.webhookSecret) {
      logger.error("Creem webhook secret is not configured");
      return Response.json(
        { error: "Webhook secret is not configured" },
        { status: 400 },
      );
    }

    // Authenticate before reading anything else out of the body: an
    // unauthenticated caller must not be able to learn how eventType, mode,
    // or the object shape are validated.
    const signature = request.headers.get("creem-signature");
    const valid = await validateWebhookSignature(
      rawBody,
      signature,
      config.billing.creem.webhookSecret,
    );
    if (!valid) {
      return Response.json({ error: "Invalid signature" }, { status: 400 });
    }

    const eventType = readString(event, "eventType");
    if (!eventType) {
      return Response.json(
        { error: "Invalid webhook payload" },
        { status: 400 },
      );
    }

    if (REVERSAL_EVENT_TYPES.has(eventType)) {
      const object = toObjectRecord(event.object);
      if (!object) {
        return Response.json(
          { error: "Invalid webhook payload" },
          { status: 400 },
        );
      }

      const objectId = readString(object, "id");
      const webhookId = readString(event, "id");
      if (!objectId && !webhookId) {
        return Response.json(
          { error: "Invalid webhook payload" },
          { status: 400 },
        );
      }

      if (object.mode !== (config.billing.creem.testMode ? "test" : "prod"))
        return Response.json(
          { error: "Webhook environment mismatch" },
          { status: 403 },
        );

      const alertKey = `billing:creem-reversal-manual:${objectId ?? webhookId}`;
      const metadata = collectReversalMetadata(object, {
        eventType,
        webhookId,
        objectId,
      });

      // Leave a trace even if the alert sink is disabled or fails: an
      // operator grepping logs for a specific refund/dispute id must be
      // able to find it regardless of whether the alert itself landed.
      logger.warn("Creem refund or dispute needs manual handling", {
        eventType,
        webhookId,
        objectId,
      });

      try {
        await alerts.trigger({
          alertKey,
          level: "error",
          source: "billing.creem",
          title: "Creem refund or dispute needs manual handling",
          message:
            "Creem sent a refund or dispute event; handle it manually in the Creem dashboard.",
          metadata,
        });
      } catch (error) {
        return failure(logger, "Failed to raise Creem reversal alert", error, {
          eventType,
          webhookId,
          objectId,
        });
      }
      return Response.json({ message: "Webhook received" });
    }

    const statuses: Record<string, TeamSubscriptionSnapshot["status"]> = {
      "checkout.completed": "inactive",
      "subscription.active": "active",
      "subscription.trialing": "trialing",
      "subscription.paid": "active",
      "subscription.scheduled_cancel": "active",
      "subscription.update": "active",
      "subscription.past_due": "past_due",
      "subscription.paused": "paused",
      "subscription.unpaid": "unpaid",
      "subscription.canceled": "canceled",
      "subscription.expired": "expired",
    };
    if (!Object.hasOwn(statuses, eventType)) {
      logger.info("Ignoring unsupported Creem webhook event", {
        eventType,
        webhookId: event.id,
      });
      return Response.json({ message: "Webhook received" });
    }

    const data = flattenCreemEvent(event);
    if (!data) {
      return Response.json(
        { error: "Invalid webhook payload" },
        { status: 400 },
      );
    }

    if (data.mode !== (config.billing.creem.testMode ? "test" : "prod"))
      return Response.json(
        { error: "Webhook environment mismatch" },
        { status: 403 },
      );
    try {
      await syncCreemSubscriptionEvent(eventType, data, statuses[eventType]!);
      return Response.json({ message: "Webhook received" });
    } catch (error) {
      return failure(logger, "Failed to process Creem webhook", error);
    }
  };
}
