import { validateWebhookSignature } from "@creem_io/better-auth/server";
import type { BillingRuntimeConfig, TeamSubscriptionSnapshot } from "../types";
import type { BillingLogger } from "../host";
import type { createCreemSubscriptionSync } from "./creem-subscription-sync";
import { toObjectRecord } from "../records";

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
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
  sync: ReturnType<typeof createCreemSubscriptionSync>;
}) {
  const config = { billing: deps.config };
  const logger = deps.logger;
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
      return null;
    }

    const event = toObjectRecord(parsed);
    if (!event) {
      return null;
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
    const eventType = readString(event, "eventType");
    if (!eventType || !Object.hasOwn(statuses, eventType)) return null;

    if (!config.billing.creem.webhookSecret) {
      logger.error("Creem webhook secret is not configured");
      return Response.json(
        { error: "Webhook secret is not configured" },
        { status: 400 },
      );
    }

    const signature = request.headers.get("creem-signature");
    const valid = await validateWebhookSignature(
      rawBody,
      signature,
      config.billing.creem.webhookSecret,
    );
    if (!valid) {
      return Response.json({ error: "Invalid signature" }, { status: 400 });
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
      logger.error("Failed to process Creem webhook", {
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        { error: "Failed to process webhook" },
        { status: 500 },
      );
    }
  };
}
