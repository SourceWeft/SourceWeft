import assert from "node:assert/strict";
import { test } from "vitest";
import { NoopBillingProvider } from "../src/server/providers/noop-provider";
import { BillingService } from "../src/server/service";
import {
  runtimeConfig,
  MemoryBillingStore,
  noopProvider,
  assertRejectsWithBillingCode,
} from "./test-fixtures";

test("billing portal never uses a customer from an unrelated personal subscription", async () => {
  const store = new MemoryBillingStore();
  const portalInputs: Array<{
    externalCustomerId?: string | null;
    externalSubscriptionId?: string | null;
  }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createPortal(input) {
        portalInputs.push({
          externalCustomerId: input.externalCustomerId,
          externalSubscriptionId: input.externalSubscriptionId,
        });
        return {
          provider: "creem",
          portalUrl: "https://billing.example.test/portal",
        };
      },
    },
  );

  await billingService.ensureBillingAccount("team_1", "user_1");
  const now = new Date().toISOString();
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: null,
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_1",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  store.order = {
    id: "order_1",
    provider: "creem",
    kind: "subscription",
    status: "fulfilled",
    paymentStatus: "paid",
    userId: "user_1",
    teamId: "personal_1",
    clientReferenceKey: null,
    planFamily: "individual_pro",
    billingInterval: "monthly",
    quantity: 1,
    unitType: null,
    unitAmount: null,
    grantedCredits: 0,
    grantedPages: 0,
    refundedAmount: 0,
    reversedUnits: 0,
    reversalStatus: "none",
    externalCheckoutId: "checkout_1",
    externalPaymentId: "pay_1",
    externalCustomerId: "cus_personal_1",
    externalSubscriptionId: "sub_personal_1",
    externalProductId: "prod_individual_monthly",
    amountTotal: 1200,
    currency: "USD",
    successUrl: null,
    cancelUrl: null,
    metadata: {},
    errorCode: null,
    errorMessage: null,
    paidAt: now,
    fulfilledAt: now,
    expiresAt: null,
    fulfillmentAttemptCount: 1,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const portal = await billingService.createBillingPortal("team_1", "user_1");
  const cancel = await billingService.cancelSubscription("team_1", "user_1");

  assert.equal(portal.portalUrl, "https://billing.example.test/portal");
  assert.equal(cancel.portalUrl, "https://billing.example.test/portal");
  assert.deepEqual(portalInputs, [
    {
      externalCustomerId: null,
      externalSubscriptionId: "ext_sub_1",
    },
    {
      externalCustomerId: null,
      externalSubscriptionId: "ext_sub_1",
    },
  ]);
});

test("pricing pro checkout reuses open order for same personal organization", async () => {
  const store = new MemoryBillingStore();
  const providerCalls: Array<unknown> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push(input);
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/pro",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const first = await billingService.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "dashboard",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
    { personalTeamId: "personal_1" },
  );
  const second = await billingService.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "dashboard",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
    { personalTeamId: "personal_1" },
  );

  assert.equal(first.orderId, second.orderId);
  assert.equal(providerCalls.length, 1);
  assert.equal(store.order?.teamId, "personal_1");
});

test("pricing pro order fulfillment works when team billing is disabled", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: false,
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/pro",
          externalCheckoutId: "checkout_1",
          externalCustomerId: "cus_1",
        };
      },
    },
  );

  const checkout = await billingService.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "dashboard",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
    { personalTeamId: "personal_1" },
  );

  const result = await billingService.processSubscriptionWebhookEvent({
    provider: "creem",
    providerEventId: "evt_pro_1",
    eventType: "subscription.active",
    payload: {},
    teamId: "personal_1",
    externalSubscriptionId: "sub_pro_1",
    snapshot: null,
    orderFulfillment: {
      orderId: checkout.orderId,
      externalCustomerId: "cus_1",
      externalSubscriptionId: "sub_pro_1",
      externalProductId: "prod_individual_monthly",
      currentPeriodStart: new Date(Date.now() - 60_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
      status: "active",
    },
  });

  assert.equal(result.outcome, "processed");
  assert.equal(store.webhook?.status, "processed");
  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.account?.teamId, "personal_1");
  assert.equal(store.account?.planFamily, "individual_pro");
  assert.equal(store.subscription?.planFamily, "individual_pro");
});

test("pricing checkout preserves unresolved provider operations without creating a second purchase", async () => {
  const store = new MemoryBillingStore();
  let shouldFail = true;
  const providerCalls: Array<unknown> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: false,
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push(input);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("provider unavailable");
        }

        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/pro-retry",
          externalCheckoutId: "checkout_retry",
          externalCustomerId: "cus_retry",
        };
      },
    },
  );

  await assert.rejects(() =>
    billingService.createPricingCheckout(
      {
        plan: "pro",
        billingInterval: "monthly",
        source: "dashboard",
      },
      {
        userId: "user_1",
        email: "user@example.com",
      },
      { personalTeamId: "personal_1" },
    ),
  );

  assert.equal(store.order?.status, "payment_failed");
  assert.equal(store.order?.paymentStatus, "failed");
  assert.equal(store.order?.errorMessage, "provider unavailable");

  await assert.rejects(
    () =>
      billingService.createPricingCheckout(
        { plan: "pro", billingInterval: "monthly", source: "dashboard" },
        { userId: "user_1", email: "user@example.com" },
        { personalTeamId: "personal_1" },
      ),
    (error: any) => error.code === "SUBSCRIPTION_PAYMENT_PENDING",
  );
  assert.equal(providerCalls.length, 1);
});

test("non-creem provider disables checkout before creating orders", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "manual",
      teamBillingEnabled: false,
    },
    new NoopBillingProvider(),
  );

  await assert.rejects(
    () =>
      billingService.createPricingCheckout(
        {
          plan: "pro",
          billingInterval: "monthly",
          source: "dashboard",
        },
        {
          userId: "user_1",
          email: "user@example.com",
        },
        { personalTeamId: "personal_1" },
      ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "BILLING_CHECKOUT_DISABLED",
      );
      assert.equal(
        (error as Error).message,
        "Billing checkout is disabled for this deployment",
      );
      return true;
    },
  );
  assert.equal(store.order, null);
});

test("oss default disables checkout before creating orders", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: false,
      provider: "none",
    },
    new NoopBillingProvider(),
  );

  await assertRejectsWithBillingCode(
    () =>
      billingService.createPricingCheckout(
        {
          plan: "pro",
          billingInterval: "monthly",
          source: "dashboard",
        },
        {
          userId: "user_1",
          email: "user@example.com",
        },
        { personalTeamId: "personal_1" },
      ),
    "BILLING_CHECKOUT_DISABLED",
  );
  assert.equal(store.order, null);
});

test("pricing pro checkout ignores missing team provider products", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      creem: {
        ...runtimeConfig.creem,
        teamStandardMonthlyProductId: "",
        teamStandardYearlyProductId: "",
      },
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/pro",
          externalCheckoutId: "checkout_1",
          externalCustomerId: "cus_1",
        };
      },
    },
  );

  const checkout = await billingService.createPricingCheckout(
    {
      plan: "pro",
      billingInterval: "monthly",
      source: "dashboard",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
    { personalTeamId: "personal_1" },
  );

  assert.equal(checkout.planFamily, "individual_pro");
  assert.equal(checkout.checkoutUrl, "https://checkout.example.test/pro");
});

test("team pricing checkout leaves team empty until fulfillment", async () => {
  const store = new MemoryBillingStore();
  const providerCalls: Array<{
    quantity: number;
    metadata?: Record<string, unknown>;
  }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: true,
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push({
          quantity: input.quantity,
          metadata: input.metadata,
        });
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/team",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const checkout = await billingService.createPricingCheckout(
    {
      plan: "team",
      billingInterval: "yearly",
      source: "landing",
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
  );

  assert.equal(checkout.planFamily, "team_standard");
  assert.equal(checkout.quantity, 2);
  assert.equal(store.order?.teamId, null);
  assert.equal(store.order?.status, "checkout_created");
  assert.equal(store.order?.metadata.teamName, undefined);
  assert.equal(providerCalls[0]?.quantity, 2);
  assert.equal(providerCalls[0]?.metadata?.teamName, undefined);
});

test("team pricing checkout uses requested seats and team name", async () => {
  const store = new MemoryBillingStore();
  const providerCalls: Array<{
    quantity: number;
    metadata?: Record<string, unknown>;
  }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: true,
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push({
          quantity: input.quantity,
          metadata: input.metadata,
        });
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/team",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const checkout = await billingService.createPricingCheckout(
    {
      plan: "team",
      billingInterval: "monthly",
      source: "landing",
      teamName: " Launch Lab ",
      seatCount: 6,
    },
    {
      userId: "user_1",
      email: "user@example.com",
    },
  );

  assert.equal(checkout.quantity, 6);
  assert.equal(store.order?.quantity, 6);
  assert.equal(store.order?.metadata.teamName, "Launch Lab");
  assert.equal(providerCalls[0]?.quantity, 6);
  assert.equal(providerCalls[0]?.metadata?.teamName, "Launch Lab");
});

test("team pricing checkout is disabled when team billing is disabled", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
      teamBillingEnabled: false,
    },
    {
      ...noopProvider,
      async createCheckout() {
        throw new Error("provider should not be called");
      },
    },
  );

  await assertRejectsWithBillingCode(
    () =>
      billingService.createPricingCheckout(
        {
          plan: "team",
          billingInterval: "monthly",
          source: "dashboard",
          teamName: "Launch Lab",
        },
        {
          userId: "user_1",
          email: "user@example.com",
        },
      ),
    "TEAM_BILLING_DISABLED",
  );
  assert.equal(store.order, null);
});

test("top-up fulfillment is idempotent and ledger backed", async () => {
  const store = new MemoryBillingStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/topup",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const checkout = await billingService.createTopupCheckout(
    "team_1",
    {
      unitType: "credit",
      quantity: 2,
    },
    "user_1",
    "user@example.com",
  );

  await billingService.fulfillOrder({ orderId: checkout.orderId });
  await billingService.fulfillOrder({ orderId: checkout.orderId });

  const topupLedgers = store.ledgers.filter(
    (entry) => entry.feature === "credit_topup_purchase",
  );
  assert.equal(topupLedgers.length, 1);
  assert.equal(topupLedgers[0]?.delta, 20_000);
  assert.equal(topupLedgers[0]?.operationType, "topup");
  assert.equal(topupLedgers[0]?.activityVisible, true);
  assert.equal(topupLedgers[0]?.activityTitle, "Credits top-up purchased");
  assert.equal(topupLedgers[0]?.activitySummary, "+20,000 credits");
  assert.equal(store.account?.addOnCreditsBalance, 20_000);
  assert.equal(store.order?.status, "fulfilled");
});

test("a failed top-up fulfillment keeps the provider payment id through the retry job", async () => {
  // MemoryBillingStore.runInTransaction is a passthrough, so a throw inside
  // it would otherwise leave the "payment_confirmed" write from fulfillOrder
  // in place. PostgresBillingStore rolls that write back on error (see
  // store.ts's runInTransaction), which is exactly what strands
  // externalPaymentId in production. Mirror that rollback here so the ledger
  // failure below reproduces the real bug instead of masking it.
  class FlakyLedgerStore extends MemoryBillingStore {
    private ledgerFailuresLeft = 1;
    async appendLedger(
      ...args: Parameters<MemoryBillingStore["appendLedger"]>
    ): ReturnType<MemoryBillingStore["appendLedger"]> {
      if (this.ledgerFailuresLeft > 0) {
        this.ledgerFailuresLeft -= 1;
        throw new Error("ledger unavailable");
      }
      return super.appendLedger(...args);
    }

    async runInTransaction<T>(
      ...args: Parameters<MemoryBillingStore["runInTransaction"]>
    ): Promise<T> {
      const snapshot = this.order ? { ...this.order } : null;
      try {
        return (await super.runInTransaction(...args)) as T;
      } catch (error) {
        this.order = snapshot;
        throw error;
      }
    }
  }

  const store = new FlakyLedgerStore();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/topup",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  const checkout = await billingService.createTopupCheckout(
    "team_1",
    {
      unitType: "credit",
      quantity: 2,
    },
    "user_1",
    "user@example.com",
  );

  await assert.rejects(
    billingService.fulfillOrder({
      orderId: checkout.orderId,
      externalPaymentId: "pi_1",
    }),
  );

  assert.equal(store.order?.status, "fulfillment_failed");
  assert.equal(store.order?.externalPaymentId, "pi_1");
  assert.equal(store.order?.paymentStatus, "paid");

  const result = await billingService.reconcileBillingOrders();

  assert.equal(result.retried, 1);
  assert.equal(store.order?.status, "fulfilled");
  assert.equal(store.order?.externalPaymentId, "pi_1");
});

test("a failing failure-bookkeeping step does not mask the fulfilment error", async () => {
  // The fulfilment transaction itself must run normally (call #1) so the
  // real fulfilment error (BILLING_ORDER_INVALID_GRANT, a stable code) is
  // what fails it; only `markFulfillmentFailed`'s own transaction (call #2)
  // — armed right before the fulfilment attempt — throws "db down".
  class FailBookkeepingStore extends MemoryBillingStore {
    private armed = false;
    private calls = 0;

    armFailBookkeeping() {
      this.armed = true;
      this.calls = 0;
    }

    async runInTransaction<T>(
      ...args: Parameters<MemoryBillingStore["runInTransaction"]>
    ): Promise<T> {
      if (this.armed) {
        this.calls += 1;
        if (this.calls === 2) {
          throw new Error("db down");
        }
      }
      return super.runInTransaction(...args) as Promise<T>;
    }
  }

  const store = new FailBookkeepingStore();
  const logged: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/topup",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
    undefined,
    {
      logger: {
        info() {},
        warn() {},
        error(message, fields) {
          logged.push({ message, fields });
        },
      },
      organizationMetadata: () => ({}),
      async createTeamOrganization() {
        throw new Error("not implemented");
      },
      async ensureMembershipWorkspace() {},
    },
  );

  const checkout = await billingService.createTopupCheckout(
    "team_1",
    { unitType: "credit", quantity: 2 },
    "user_1",
    "user@example.com",
  );
  // Force the grant check inside fulfilment to fail with a stable code.
  store.order = { ...store.order!, grantedCredits: 0 };

  store.armFailBookkeeping();
  await assertRejectsWithBillingCode(
    () => billingService.fulfillOrder({ orderId: checkout.orderId }),
    "BILLING_ORDER_INVALID_GRANT",
  );

  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.message, "Failed to record fulfillment failure");
  assert.equal(logged[0]?.fields?.orderId, checkout.orderId);
  assert.equal(logged[0]?.fields?.code, "BILLING_ORDER_INVALID_GRANT");
  assert.equal(logged[0]?.fields?.bookkeepingError, "db down");
});

test("a throwing alert sink during markFulfillmentFailed still marks the order failed and rethrows the original error", async () => {
  const store = new MemoryBillingStore();
  const logged: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const throwingAlerts = {
    async trigger() {
      throw new Error("alert sink down");
    },
    async resolve() {},
  };
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout() {
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/topup",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
    throwingAlerts,
    {
      logger: {
        info() {},
        warn() {},
        error(message, fields) {
          logged.push({ message, fields });
        },
      },
      organizationMetadata: () => ({}),
      async createTeamOrganization() {
        throw new Error("not implemented");
      },
      async ensureMembershipWorkspace() {},
    },
  );

  const checkout = await billingService.createTopupCheckout(
    "team_1",
    { unitType: "credit", quantity: 2 },
    "user_1",
    "user@example.com",
  );
  // Force the grant check inside fulfilment to fail with a stable code.
  store.order = { ...store.order!, grantedCredits: 0 };

  await assertRejectsWithBillingCode(
    () => billingService.fulfillOrder({ orderId: checkout.orderId }),
    "BILLING_ORDER_INVALID_GRANT",
  );

  // The bookkeeping WRITE succeeded (only the alert sink failed), so this is
  // not a bookkeeping failure: no "Failed to record fulfillment failure" log.
  assert.equal(
    logged.some(
      (entry) => entry.message === "Failed to record fulfillment failure",
    ),
    false,
  );
  assert.equal(store.order?.status, "fulfillment_failed");
});
