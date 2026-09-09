import { createHash } from "node:crypto";
import { WaffoPancake } from "@waffo/pancake-ts";
import type { BillingRuntimeConfig } from "../../types";
import { BillingError } from "../../errors";

export function createWaffoClient(
  config: BillingRuntimeConfig,
  fetch?: typeof globalThis.fetch,
) {
  if (!/^MER_[A-Za-z0-9]{22}$/.test(config.waffo.merchantId)) {
    throw new BillingError(
      "WAFFO_MERCHANT_ID_INVALID",
      500,
      "Use the Merchant ID from Waffo API & Development, not a Store ID",
    );
  }
  try {
    return new WaffoPancake({
      merchantId: config.waffo.merchantId,
      privateKey: config.waffo.privateKey,
      environment: config.waffo.environment,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (
          String(input).endsWith("/v1/actions/checkout/create-session") &&
          typeof init?.body === "string"
        ) {
          const body = JSON.parse(init.body);
          if (typeof body.metadata?.sourceweftOrderId === "string") {
            // The SDK signs the original body. Its supported transport hook supplies a stable
            // merchant-scoped idempotency key instead of the default 60-second window.
            headers.set(
              "X-Idempotency-Key",
              createHash("sha256")
                .update(`${config.waffo.merchantId}:${init.body}`)
                .digest("hex"),
            );
          }
        }
        return (fetch ?? globalThis.fetch)(input, {
          ...init,
          headers,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        });
      },
    });
  } catch {
    throw new BillingError(
      "WAFFO_PRIVATE_KEY_INVALID",
      500,
      "WAFFO_PRIVATE_KEY must contain a valid RSA private key",
    );
  }
}
export function centsToDisplay(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0)
    throw new BillingError(
      "WAFFO_AMOUNT_INVALID",
      400,
      "Checkout amount must be positive whole USD cents",
    );
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
export function displayToCents(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new BillingError(
      "WAFFO_AMOUNT_INVALID",
      422,
      "Invalid USD display amount in payment event",
    );
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount))
    throw new BillingError(
      "WAFFO_AMOUNT_INVALID",
      422,
      "Payment amount is outside supported range",
    );
  return amount;
}
