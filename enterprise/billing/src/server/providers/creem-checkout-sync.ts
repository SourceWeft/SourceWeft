import { BillingError } from "../errors";
import { toObjectRecord } from "../records";
import type { BillingService } from "../service";
import type { BillingRuntimeConfig } from "../types";

const id = (value: unknown) =>
  typeof value === "string" ? value : toObjectRecord(value)?.id;

/** Receives only the official Auth plugin's signature-verified checkout callback. */
export async function syncCreemCheckoutCompleted(input: {
  billing: BillingService;
  config: BillingRuntimeConfig;
  data: unknown;
}) {
  const checkout = toObjectRecord(input.data);
  const metadata = toObjectRecord(checkout?.metadata);
  // Subscription domain events own subscription periods and entitlements.
  if (!metadata?.orderId || checkout?.subscription) return;
  const order = await input.billing.getOrder(String(metadata.orderId));
  if (!order)
    throw new BillingError(
      "CREEM_ORDER_NOT_FOUND",
      422,
      "Checkout order was not found",
    );
  if (order.kind === "subscription") return;
  const payment = toObjectRecord(checkout?.order);
  const environment = input.config.creem.testMode ? "test" : "prod";
  if (
    checkout?.mode !== environment ||
    payment?.mode !== environment ||
    order.metadata.paymentEnvironment !== environment
  )
    throw new BillingError(
      "CREEM_ENVIRONMENT_MISMATCH",
      422,
      "Checkout environment differs from the purchase",
    );
  if (
    order.provider !== "creem" ||
    metadata.orderId !== order.id ||
    checkout?.request_id !== `order:${order.id}` ||
    metadata.userId !== order.userId ||
    metadata.teamId !== order.teamId ||
    metadata.kind !== order.kind ||
    Number(checkout?.units) !== order.quantity ||
    id(checkout?.product) !== order.externalProductId ||
    payment?.product !== order.externalProductId ||
    (order.externalCheckoutId && checkout?.id !== order.externalCheckoutId)
  )
    throw new BillingError(
      "CREEM_ORDER_BINDING_MISMATCH",
      422,
      "Checkout does not match the persisted purchase",
    );
  if (
    checkout?.status !== "completed" ||
    payment?.status !== "paid" ||
    payment.type !== "onetime" ||
    typeof payment.id !== "string"
  )
    throw new BillingError(
      "CREEM_PAYMENT_INVALID",
      422,
      "Checkout has no completed one-time payment",
    );
  const paid = payment.amount_paid ?? payment.amount;
  const tax = payment.tax_amount ?? 0;
  if (
    typeof paid !== "number" ||
    !Number.isSafeInteger(paid) ||
    typeof tax !== "number" ||
    !Number.isSafeInteger(tax) ||
    tax < 0 ||
    (paid !== order.amountTotal && paid - tax !== order.amountTotal) ||
    String(payment.currency).toLowerCase() !== order.currency?.toLowerCase()
  )
    throw new BillingError(
      "CREEM_AMOUNT_MISMATCH",
      422,
      "Checkout amount or currency differs from the purchase",
    );
  if (typeof checkout.webhookId !== "string" || !checkout.webhookId)
    throw new BillingError(
      "CREEM_EVENT_INVALID",
      400,
      "Checkout event has no identifier",
    );
  await input.billing.processSubscriptionWebhookEvent({
    provider: "creem",
    providerEventId: checkout.webhookId,
    eventType: "checkout.completed",
    payload: checkout,
    metadata: { paymentEnvironment: environment },
    teamId: order.teamId,
    externalSubscriptionId: null,
    snapshot: null,
    orderFulfillment: {
      orderId: order.id,
      externalPaymentId:
        typeof payment.transaction === "string"
          ? payment.transaction
          : payment.id,
      externalCustomerId:
        typeof id(checkout.customer) === "string"
          ? String(id(checkout.customer))
          : null,
      externalProductId: order.externalProductId,
      metadata: { creemCheckoutId: checkout.id, creemOrderId: payment.id },
    },
  });
}
