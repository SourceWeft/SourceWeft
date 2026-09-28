import type { BillingAlertSink, BillingLogger } from "../host";
import type { BillingStore } from "../store-port";

// Creem redelivers a failed webhook up to 5 times over roughly 6.5 hours,
// then stops. A receipt still `failed` past that window has nothing local
// retrying it, so it is stranded -- possibly a customer who paid and was
// never granted. 7 hours gives Creem's own redelivery schedule room to
// finish before this scan calls a receipt stranded.
const STRANDED_RECEIPT_WINDOW_MS = 7 * 60 * 60 * 1000;
const STRANDED_RECEIPT_SCAN_LIMIT = 50;

export type MonitorStrandedCreemReceiptsDeps = {
  store: Pick<BillingStore, "listStrandedWebhookEvents">;
  alerts: BillingAlertSink;
  logger: BillingLogger;
  now?: () => Date;
};

/**
 * Alert-only scan for Creem webhook receipts that Creem gave up retrying.
 * We keep every receipt in `billing_webhook_events`, but there is no local
 * retry for Creem deliveries, so this never replays the event -- it only
 * raises one ops alert per stranded receipt so a human can resend it from
 * the Creem dashboard (decision D1 in the payment-reversal-followups plan).
 *
 * A receipt that is still `failed` on the next scheduler tick raises the
 * same alert key again; the ops sink dedupes repeated triggers of one key,
 * so this is intended, not a bug.
 */
export async function monitorStrandedCreemReceipts(
  deps: MonitorStrandedCreemReceiptsDeps,
): Promise<{ alerted: number }> {
  const now = deps.now ?? (() => new Date());
  const receivedBefore = new Date(now().getTime() - STRANDED_RECEIPT_WINDOW_MS);

  const receipts = await deps.store.listStrandedWebhookEvents({
    provider: "creem",
    receivedBefore,
    limit: STRANDED_RECEIPT_SCAN_LIMIT,
  });

  let alerted = 0;
  for (const receipt of receipts) {
    try {
      await deps.alerts.trigger({
        alertKey: `billing:creem-receipt-stranded:${receipt.id}`,
        level: "error",
        source: "billing.creem",
        title: "Creem webhook needs a manual resend",
        message:
          "Creem gave up retrying this webhook delivery. Resend the event from the Creem dashboard.",
        metadata: {
          eventType: receipt.eventType,
          providerEventId: receipt.providerEventId,
          teamId: receipt.teamId,
          externalSubscriptionId: receipt.externalSubscriptionId,
          attemptCount: receipt.attemptCount,
          errorCode: receipt.errorCode,
        },
      });
      alerted += 1;
    } catch (error) {
      // An ops-sink failure must not stop the scan: the rest of the
      // stranded receipts still need their alert raised this tick.
      deps.logger.error("Failed to emit stranded Creem receipt alert", {
        webhookEventId: receipt.id,
        providerEventId: receipt.providerEventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { alerted };
}
