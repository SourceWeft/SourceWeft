// Creem redelivers a failed webhook up to 5 times over ~6.5 hours, then gives
// up. Nothing locally retries a Creem delivery, so a receipt still `failed`
// after Creem stops trying is silently stuck -- possibly a customer who paid
// and was never granted. `monitorStrandedCreemReceipts` raises one ops alert
// per stranded receipt so a human can resend it from the Creem dashboard; it
// never replays the event itself (payment-reversal-followups D1).
import assert from "node:assert/strict";
import { test } from "vitest";
import { monitorStrandedCreemReceipts } from "../src/server/providers/creem-receipt-monitor";
import type { BillingAlertSink, BillingLogger } from "../src/server/host";
import type { BillingWebhookEventState } from "../src/server/types";
import { MemoryBillingStore } from "./test-fixtures";

type RecordedAlert = Parameters<BillingAlertSink["trigger"]>[0];

const NOW = new Date("2026-09-28T12:00:00.000Z");

function hoursAgo(hours: number) {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

const noopLogger: BillingLogger = {
  info() {},
  warn() {},
  error() {},
};

function seedReceipt(
  store: MemoryBillingStore,
  overrides: Partial<BillingWebhookEventState> & {
    id: string;
    providerEventId: string;
  },
): BillingWebhookEventState {
  const receivedAt = overrides.receivedAt ?? hoursAgo(8);
  const receipt: BillingWebhookEventState = {
    id: overrides.id,
    provider: overrides.provider ?? "creem",
    providerEventId: overrides.providerEventId,
    eventType: overrides.eventType ?? "subscription.active",
    teamId: overrides.teamId === undefined ? "team_1" : overrides.teamId,
    externalSubscriptionId:
      overrides.externalSubscriptionId === undefined
        ? "ext_sub_1"
        : overrides.externalSubscriptionId,
    status: overrides.status ?? "failed",
    attemptCount: overrides.attemptCount ?? 5,
    receivedAt,
    processedAt: overrides.processedAt ?? null,
    errorCode:
      overrides.errorCode === undefined
        ? "processing_error"
        : overrides.errorCode,
    errorMessage: overrides.errorMessage ?? "boom",
    payload: overrides.payload ?? {},
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? receivedAt,
    updatedAt: overrides.updatedAt ?? receivedAt,
  };
  store.webhooks.set(`${receipt.provider}:${receipt.providerEventId}`, receipt);
  return receipt;
}

function createAlertSink() {
  const triggered: RecordedAlert[] = [];
  const alerts: BillingAlertSink = {
    async trigger(input) {
      triggered.push(input);
    },
    async resolve() {},
  };
  return { alerts, triggered };
}

test("stranded Creem receipts older than 7 hours raise one error alert each", async () => {
  const store = new MemoryBillingStore();
  const stale1 = seedReceipt(store, {
    id: "webhook_stale_1",
    providerEventId: "evt_stale_1",
    receivedAt: hoursAgo(8),
    attemptCount: 5,
    errorCode: "processing_error",
  });
  const stale2 = seedReceipt(store, {
    id: "webhook_stale_2",
    providerEventId: "evt_stale_2",
    receivedAt: hoursAgo(8),
    teamId: null,
    externalSubscriptionId: null,
    attemptCount: 5,
    errorCode: "duplicate_conflict",
  });
  seedReceipt(store, {
    id: "webhook_recent",
    providerEventId: "evt_recent",
    receivedAt: hoursAgo(1),
  });
  seedReceipt(store, {
    id: "webhook_processed",
    providerEventId: "evt_processed",
    receivedAt: hoursAgo(9),
    status: "processed",
  });

  const { alerts, triggered } = createAlertSink();

  const result = await monitorStrandedCreemReceipts({
    store,
    alerts,
    logger: noopLogger,
    now: () => NOW,
  });

  assert.equal(result.alerted, 2);
  assert.deepEqual(
    triggered.map((alert) => alert.alertKey).sort(),
    [
      `billing:creem-receipt-stranded:${stale1.id}`,
      `billing:creem-receipt-stranded:${stale2.id}`,
    ].sort(),
  );

  const first = triggered.find(
    (alert) => alert.alertKey === `billing:creem-receipt-stranded:${stale1.id}`,
  );
  assert.ok(first);
  assert.equal(first?.level, "error");
  assert.equal(first?.source, "billing.creem");
  assert.equal(first?.title, "Creem webhook needs a manual resend");
  assert.equal(typeof first?.message, "string");
  assert.ok(first?.message.length);
  assert.deepEqual(first?.metadata, {
    eventType: stale1.eventType,
    providerEventId: stale1.providerEventId,
    teamId: stale1.teamId,
    externalSubscriptionId: stale1.externalSubscriptionId,
    attemptCount: stale1.attemptCount,
    errorCode: stale1.errorCode,
  });

  const second = triggered.find(
    (alert) => alert.alertKey === `billing:creem-receipt-stranded:${stale2.id}`,
  );
  assert.ok(second);
  assert.equal(second?.metadata?.teamId, null);
  assert.equal(second?.metadata?.externalSubscriptionId, null);
});

test("a receipt that stays failed alerts under the same key every tick", async () => {
  const store = new MemoryBillingStore();
  const receipt = seedReceipt(store, {
    id: "webhook_persistent",
    providerEventId: "evt_persistent",
    receivedAt: hoursAgo(8),
  });

  const run1 = createAlertSink();
  const result1 = await monitorStrandedCreemReceipts({
    store,
    alerts: run1.alerts,
    logger: noopLogger,
    now: () => NOW,
  });

  // A later tick: the receipt is still failed (no local retry ever touches
  // it), so it is still in the window and must alert again under the same
  // key -- the ops sink is what dedupes repeated triggers of one key.
  const run2 = createAlertSink();
  const result2 = await monitorStrandedCreemReceipts({
    store,
    alerts: run2.alerts,
    logger: noopLogger,
    now: () => new Date(NOW.getTime() + 60 * 60 * 1000),
  });

  assert.equal(result1.alerted, 1);
  assert.equal(result2.alerted, 1);
  const expectedKey = `billing:creem-receipt-stranded:${receipt.id}`;
  assert.deepEqual(
    run1.triggered.map((alert) => alert.alertKey),
    [expectedKey],
  );
  assert.deepEqual(
    run2.triggered.map((alert) => alert.alertKey),
    [expectedKey],
  );
});

test("alert failure does not stop the scan", async () => {
  const store = new MemoryBillingStore();
  // Oldest first: the scan must reach the second receipt even though the
  // first one's alert throws.
  const older = seedReceipt(store, {
    id: "webhook_alert_throws",
    providerEventId: "evt_alert_throws",
    receivedAt: hoursAgo(9),
  });
  const newer = seedReceipt(store, {
    id: "webhook_alert_ok",
    providerEventId: "evt_alert_ok",
    receivedAt: hoursAgo(8),
  });

  const olderKey = `billing:creem-receipt-stranded:${older.id}`;
  const newerKey = `billing:creem-receipt-stranded:${newer.id}`;
  const triggeredKeys: string[] = [];
  const alerts: BillingAlertSink = {
    async trigger(input) {
      if (input.alertKey === olderKey) {
        throw new Error("ops sink unavailable");
      }
      triggeredKeys.push(input.alertKey);
    },
    async resolve() {},
  };
  const loggedErrors: Array<{
    message: string;
    fields?: Record<string, unknown>;
  }> = [];
  const logger: BillingLogger = {
    info() {},
    warn() {},
    error(message, fields) {
      loggedErrors.push({ message, fields });
    },
  };

  const result = await monitorStrandedCreemReceipts({
    store,
    alerts,
    logger,
    now: () => NOW,
  });

  assert.deepEqual(triggeredKeys, [newerKey]);
  assert.equal(result.alerted, 1);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.fields?.webhookEventId, older.id);
});
