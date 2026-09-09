import { generateKeyPairSync, sign } from "node:crypto";
import {
  WaffoPancake,
  verifyWebhook,
  type WebhookEvent,
} from "@waffo/pancake-ts";
import { MemoryBillingStore, runtimeConfig } from "./test-fixtures";
import type { BillingStore } from "../src/server/store-port";
import { BillingService } from "../src/server/service";
import { WaffoBillingProvider } from "../src/server/providers/waffo/provider";
import { WaffoWebhookService } from "../src/server/providers/waffo/webhook";
import type {
  WaffoSettings,
  WaffoStateStore,
} from "../src/server/providers/waffo/state";

export const merchantId = "MER_2aUyqjCzEIiEcYMKj7TZtw";
export const storeId = "STO_2aUyqjCzEIiEcYMKj7TZtw";
export const productId = "PROD_2aUyqjCzEIiEcYMKj7TZtw";
export const signingKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
export const waffoConfig = {
  ...runtimeConfig,
  saasEnabled: true,
  provider: "waffo" as const,
  waffo: {
    merchantId,
    privateKey: signingKey.privateKey,
    environment: "test" as const,
  },
};

export class WaffoMemoryStore extends MemoryBillingStore {
  override async getOrderById(id?: string) {
    return !id || this.order?.id === id ? this.order : null;
  }
  override async getOrderByClientReference(_user?: string, key?: string) {
    return this.order?.clientReferenceKey === key ? this.order : null;
  }
  override async insertWebhookEvent(
    input: Parameters<BillingStore["insertWebhookEvent"]>[0],
  ) {
    const existing = this.webhooks.get(
      `${input.provider}:${input.providerEventId}`,
    );
    if (existing) return existing;
    const row = await super.insertWebhookEvent(input);
    row.id = `receipt_${this.webhooks.size}`;
    return row;
  }
  override async incrementWebhookEventAttempt(
    id: string,
    input: Parameters<BillingStore["incrementWebhookEventAttempt"]>[1],
  ) {
    this.webhook =
      [...this.webhooks.values()].find((row) => row.id === id) ?? null;
    return super.incrementWebhookEventAttempt(id, input);
  }
  override async updateWebhookEventState(
    id: string,
    input: Parameters<BillingStore["updateWebhookEventState"]>[1],
  ) {
    this.webhook =
      [...this.webhooks.values()].find((row) => row.id === id) ?? null;
    return super.updateWebhookEventState(id, input);
  }
}
export class MemoryWaffoState implements WaffoStateStore {
  settings: WaffoSettings | null = {
    merchantId,
    environment: "test",
    storeId,
    products: {
      credit_topup: productId,
      page_topup: productId,
      "individual_pro:monthly": productId,
      "individual_pro:yearly": productId,
      "team_standard:monthly": productId,
    },
  };
  constructor(private readonly store: WaffoMemoryStore) {}
  async getSettings() {
    return this.settings;
  }
  async saveSettings(settings: WaffoSettings) {
    this.settings = { ...settings, products: { ...settings.products } };
  }
  private readonly locks = new Map<string, Promise<void>>();
  async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await run();
    } finally {
      unlock();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
  async pendingEvents(settings: WaffoSettings) {
    return [...this.store.webhooks.values()]
      .filter(
        (row) =>
          ["received", "failed"].includes(row.status) &&
          row.payload.mode === settings.environment &&
          row.payload.storeId === settings.storeId,
      )
      .map((row) => row.payload as unknown as WebhookEvent);
  }
}
export function createWaffoFixture() {
  const requests: Array<{
    url: string;
    body: Record<string, any>;
    headers: Headers;
  }> = [];
  const client = new WaffoPancake({
    merchantId,
    privateKey: signingKey.privateKey,
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return new Response(
        JSON.stringify({
          data: {
            sessionId: `cs_test_${requests.length}`,
            checkoutUrl: `https://pancake.waffo.ai/checkout/cs_test_${requests.length}`,
            expiresAt: new Date(Date.now() + 2_700_000).toISOString(),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const store = new WaffoMemoryStore();
  const state = new MemoryWaffoState(store);
  const provider = new WaffoBillingProvider(waffoConfig, state, client);
  const billing = new BillingService(store, waffoConfig, provider);
  const logger = { info() {}, warn() {}, error() {} };
  const makeInbox = () =>
    new WaffoWebhookService({
      config: waffoConfig,
      state,
      store,
      billing,
      logger,
      verify: (raw, signature, environment) =>
        verifyWebhook(raw, signature, {
          environment,
          publicKey: signingKey.publicKey,
        }),
    });
  const inbox = makeInbox();
  const event = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
    id: "delivery_1",
    eventId: "PAY_test",
    timestamp: new Date().toISOString(),
    eventType: "order.completed",
    mode: "test",
    storeId,
    storeName: "Test store",
    data: {
      orderId: "ORD_2aUyqjCzEIiEcYMKj7TZtw",
      orderMerchantExternalId: store.order!.id,
      orderMetadata: { sourceweftOrderId: store.order!.id },
      buyerEmail: "buyer@example.invalid",
      currency: "USD",
      amount: "12.50",
      total: "12.50",
      taxAmount: "0.00",
      productName: "SourceWeft Credits",
      productMetadata: { sourceweftProductKey: "credit_topup" },
      paymentId: "PAY_test",
      paymentStatus: "succeeded",
      orderStatus: "completed",
    },
    ...overrides,
  });
  return {
    requests,
    client,
    store,
    state,
    provider,
    billing,
    inbox,
    makeInbox,
    event,
  };
}
export function signedEvent(event: WebhookEvent, timestamp = Date.now()) {
  // Test-only provider key. Production request signing and verification stay in the official SDK.
  const raw = JSON.stringify(event, null, 2);
  return {
    raw,
    signature: `t=${timestamp},v1=${sign("sha256", Buffer.from(`${timestamp}.${raw}`), signingKey.privateKey).toString("base64")}`,
  };
}
