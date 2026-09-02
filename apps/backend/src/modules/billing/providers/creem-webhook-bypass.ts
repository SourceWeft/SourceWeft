import { validateWebhookSignature } from "@creem_io/better-auth/server";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import { syncCreemSubscriptionEvent } from "../index";
import { toObjectRecord } from "../../../shared/records";

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function flattenScheduledCancelEvent(event: Record<string, unknown>) {
  const object = toObjectRecord(event.object);
  if (!object) {
    return null;
  }

  return {
    webhookEventType: event.eventType,
    webhookId: event.id,
    webhookCreatedAt: event.created_at,
    ...object,
  };
}

export async function handleCreemScheduledCancelWebhook(request: Request) {
  if (
    config.billing.provider !== "creem" ||
    !request.url.includes("/api/auth/creem/webhook")
  ) {
    return null;
  }

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

  if (readString(event, "eventType") !== "subscription.scheduled_cancel") {
    return null;
  }

  if (!config.billing.creem.webhookSecret) {
    logger.error("Creem scheduled cancel webhook secret is not configured");
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

  const data = flattenScheduledCancelEvent(event);
  if (!data) {
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  try {
    await syncCreemSubscriptionEvent(
      "subscription.scheduled_cancel",
      data,
      "active",
    );
    return Response.json({ message: "Webhook received" });
  } catch (error) {
    logger.error("Failed to process creem scheduled cancel webhook", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Failed to process webhook" },
      { status: 500 },
    );
  }
}
