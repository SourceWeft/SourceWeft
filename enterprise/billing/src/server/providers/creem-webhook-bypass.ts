import { validateWebhookSignature } from "@creem_io/better-auth/server";
import type { BillingRuntimeConfig, TeamSubscriptionSnapshot } from "../types";
import type { BillingLogger } from "../host";
import type { createCreemReversalSync } from "./creem-reversal-sync";
import type { createCreemSubscriptionSync } from "./creem-subscription-sync";
import { toObjectRecord } from "../records";

// Refund and dispute events go to the reversal sync, which translates them
// into the payment-reversal core's input (or a notice, for anything the
// core does not apply). This handler only authenticates the envelope and
// checks the deployment mode before dispatching.
const REVERSAL_EVENT_TYPES = new Set(["refund.created", "dispute.created"]);

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
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
  sync: ReturnType<typeof createCreemSubscriptionSync>;
  reversalSync: ReturnType<typeof createCreemReversalSync>;
}) {
  const config = { billing: deps.config };
  const logger = deps.logger;
  const syncCreemSubscriptionEvent = deps.sync;
  const syncCreemReversalEvent = deps.reversalSync;
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
      const data = flattenCreemEvent(event);
      if (!data) {
        return Response.json(
          { error: "Invalid webhook payload" },
          { status: 400 },
        );
      }

      const objectId = readString(data, "id");
      const webhookId = readString(data, "webhookId");
      if (!objectId && !webhookId) {
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
        await syncCreemReversalEvent(
          eventType as "refund.created" | "dispute.created",
          data,
        );
        return Response.json({ message: "Webhook received" });
      } catch (error) {
        return failure(
          logger,
          "Failed to process Creem reversal webhook",
          error,
          {
            eventType,
            webhookId,
            objectId,
          },
        );
      }
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
