import Stripe from "stripe";
import { MemoryBillingStore, runtimeConfig } from "./test-fixtures";
import type { BillingStore } from "../src/server/store-port";
import { BillingService } from "../src/server/service";
import { StripeBillingProvider } from "../src/server/providers/stripe/provider";
import { StripeWebhookService } from "../src/server/providers/stripe/webhook";
import type { StripeInboxStore } from "../src/server/providers/stripe/state";

export const stripeConfig = {
  ...runtimeConfig,
  saasEnabled: true,
  provider: "stripe" as const,
  stripe: {
    secretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    testMode: true,
  },
};
export class StripeMemoryStore extends MemoryBillingStore {
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
  override async updateWebhookEventState(
    id: string,
    input: Parameters<BillingStore["updateWebhookEventState"]>[1],
  ) {
    this.webhook =
      [...this.webhooks.values()].find((row) => row.id === id) ?? null;
    return super.updateWebhookEventState(id, input);
  }
  override async incrementWebhookEventAttempt(
    id: string,
    input: Parameters<BillingStore["incrementWebhookEventAttempt"]>[1],
  ) {
    this.webhook =
      [...this.webhooks.values()].find((row) => row.id === id) ?? null;
    return super.incrementWebhookEventAttempt(id, input);
  }
}
export class MemoryStripeInbox implements StripeInboxStore {
  constructor(private readonly store: StripeMemoryStore) {}
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
  async pendingEvents(testMode: boolean) {
    return [...this.store.webhooks.values()]
      .filter(
        (row) =>
          row.provider === "stripe" &&
          ["received", "failed"].includes(row.status) &&
          row.payload.livemode === !testMode,
      )
      .map((row) => row.payload as unknown as Stripe.Event);
  }
}
export function stripeFixture(options: { teamBillingEnabled?: boolean } = {}) {
  const config = { ...stripeConfig, ...options };
  const requests: Array<{
    path: string;
    method: string;
    body: URLSearchParams;
    headers: Headers;
  }> = [];
  const remote = {
    accountId: "acct_fixture",
    sessions: new Map<string, Stripe.Checkout.Session>(),
    subscription: null as Stripe.Subscription | null,
    invoice: null as Stripe.Invoice | null,
    rejectSeatPayment: false,
  };
  const client = new Stripe(stripeConfig.stripe.secretKey, {
    apiVersion: Stripe.API_VERSION,
    telemetry: false,
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const body = new URLSearchParams(String(init?.body ?? ""));
      requests.push({
        path,
        method,
        body,
        headers: new Headers(init?.headers),
      });
      let data: unknown;
      if (path === "/v1/account")
        data = { id: remote.accountId, object: "account" };
      else if (path === "/v1/checkout/sessions" && method === "POST") {
        const id = `cs_test_${remote.sessions.size + 1}`;
        const quantity = Number(body.get("line_items[0][quantity]"));
        const unitAmount = Number(
          body.get("line_items[0][price_data][unit_amount]"),
        );
        const metadata: Record<string, string> = {};
        for (const [key, value] of body) {
          const match = /^metadata\[(.+)\]$/.exec(key);
          if (match) metadata[match[1]!] = value;
        }
        data = {
          id,
          object: "checkout.session",
          mode: body.get("mode"),
          livemode: false,
          status: "open",
          payment_status: "unpaid",
          amount_total: quantity * unitAmount,
          currency: "usd",
          customer: "cus_fixture",
          subscription: null,
          payment_intent: null,
          client_reference_id: body.get("client_reference_id"),
          metadata,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          line_items: {
            data: [
              {
                id: `li_${id}`,
                quantity,
                price: {
                  id: `price_${id}`,
                  currency: "usd",
                  unit_amount: unitAmount,
                  product: {
                    id: `prod_${id}`,
                    object: "product",
                    metadata: {
                      sourceweftProductKey: metadata.sourceweftProductKey,
                    },
                  },
                  recurring:
                    body.get("mode") === "subscription"
                      ? {
                          interval: body.get(
                            "line_items[0][price_data][recurring][interval]",
                          ),
                          interval_count: 1,
                        }
                      : null,
                },
              },
            ],
            has_more: false,
          },
        };
        remote.sessions.set(id, data as Stripe.Checkout.Session);
      } else if (path.startsWith("/v1/checkout/sessions/"))
        data = remote.sessions.get(path.split("/").pop()!);
      else if (path.startsWith("/v1/subscriptions/") && method === "POST") {
        if (remote.rejectSeatPayment)
          return new Response(
            JSON.stringify({
              error: {
                type: "card_error",
                message: "Authentication required",
                code: "authentication_required",
              },
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        remote.subscription!.items.data[0]!.quantity = Number(
          body.get("items[0][quantity]"),
        );
        data = remote.subscription;
      } else if (path.startsWith("/v1/subscriptions/"))
        data = remote.subscription;
      else if (path.startsWith("/v1/invoices/")) data = remote.invoice;
      else if (path === "/v1/billing_portal/sessions")
        data = {
          id: "bps_fixture",
          object: "billing_portal.session",
          url: "https://billing.stripe.com/p/session/fixture",
        };
      else throw new Error(`Unexpected Stripe request ${method} ${path}`);
      return new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json",
          "request-id": "req_fixture",
        },
      });
    }),
  });
  const store = new StripeMemoryStore();
  const state = new MemoryStripeInbox(store);
  const provider = new StripeBillingProvider(config, client);
  const billing = new BillingService(store, config, provider);
  const makeInbox = () =>
    new StripeWebhookService({
      config,
      provider,
      state,
      store,
      billing,
      logger: { info() {}, warn() {}, error() {} },
    });
  const pay = (sessionId = store.order!.externalCheckoutId!) => {
    const session = remote.sessions.get(sessionId)!;
    session.status = "complete";
    session.payment_status = "paid";
    if (session.mode === "payment") session.payment_intent = `pi_${session.id}`;
    else {
      session.subscription = "sub_fixture";
      const now = Math.floor(Date.now() / 1000);
      remote.invoice = {
        id: "in_fixture",
        object: "invoice",
        livemode: false,
        status: "paid",
        amount_paid: session.amount_total,
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_fixture",
            metadata: session.metadata,
          },
        },
      } as unknown as Stripe.Invoice;
      remote.subscription = {
        id: "sub_fixture",
        object: "subscription",
        livemode: false,
        status: "active",
        metadata: session.metadata,
        customer: session.customer,
        cancel_at_period_end: false,
        pending_update: null,
        latest_invoice: remote.invoice,
        items: {
          data: [
            {
              id: "si_fixture",
              quantity: session.line_items!.data[0]!.quantity,
              price: session.line_items!.data[0]!.price,
              current_period_start: now - 60,
              current_period_end: now + 30 * 86400,
            },
          ],
          has_more: false,
        },
      } as unknown as Stripe.Subscription;
    }
    return session;
  };
  const event = (
    type: string,
    object: unknown,
    id = `evt_${Math.random().toString(36).slice(2)}`,
  ): Stripe.Event =>
    ({
      id,
      object: "event",
      type,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    }) as Stripe.Event;
  const sign = (event: Stripe.Event, timestamp?: number) => {
    const raw = JSON.stringify(event, null, 2);
    return {
      raw,
      signature: client.webhooks.generateTestHeaderString({
        payload: raw,
        secret: stripeConfig.stripe.webhookSecret,
        ...(timestamp ? { timestamp } : {}),
      }),
    };
  };
  return {
    client,
    remote,
    requests,
    store,
    state,
    provider,
    billing,
    makeInbox,
    pay,
    event,
    sign,
  };
}
