import assert from "node:assert/strict";
import { test } from "vitest";
import { BillingAccountService } from "./account-service";
import { resolveCreemSubscriptionSeatUpdateItem } from "./providers/creem-provider";
import { BillingService } from "./service";
import { BillingUsageService } from "./usage-service";
import {
  runtimeConfig,
  MemoryBillingStore,
  noopProvider,
  createActiveTeamAccount,
  createActiveTeamSubscription,
  assertRejectsWithBillingCode,
} from "./test-fixtures";

test("billing summary counts pending invitations as occupied seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 3 });
  const accountService = new BillingAccountService(store, runtimeConfig);
  const usageService = new BillingUsageService(
    store,
    runtimeConfig,
    accountService,
  );

  const summary = await usageService.getSummary("team_1", "user_1");

  assert.equal(summary.seats.used, 3);
  assert.equal(summary.seats.remaining, 0);
  assert.equal(summary.seats.activeMembers, 2);
  assert.equal(summary.seats.pendingInvitations, 1);

  store.pendingInvitationCount = 0;
  const afterRevoke = await usageService.getSummary("team_1", "user_1");

  assert.equal(afterRevoke.seats.used, 2);
  assert.equal(afterRevoke.seats.remaining, 1);
  assert.equal(afterRevoke.seats.activeMembers, 2);
  assert.equal(afterRevoke.seats.pendingInvitations, 0);
});

test("team subscription checkout rejects seats below allocated members and invites", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  const providerCalls: Array<unknown> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      saasEnabled: true,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async createCheckout(input) {
        providerCalls.push(input);
        return {
          provider: "creem",
          checkoutUrl: "https://checkout.example.test/team",
          externalCheckoutId: null,
          externalCustomerId: null,
        };
      },
    },
  );

  await assertRejectsWithBillingCode(
    () =>
      billingService.createSubscriptionCheckout(
        "team_1",
        {
          planFamily: "team_standard",
          billingInterval: "monthly",
          seatCount: 2,
        },
        {
          userId: "user_1",
          email: "user@example.com",
        },
      ),
    "SEAT_COUNT_BELOW_ALLOCATED_SEATS",
  );
  assert.equal(providerCalls.length, 0);
});

test("team subscription seat sync updates provider before local quota", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 3;
  const now = new Date().toISOString();
  store.account = {
    teamId: "team_1",
    userId: "user_1",
    planFamily: "team_standard",
    cycleAnchorAt: now,
    cycleSource: "provider_subscription",
    cycleStartAt: now,
    cycleEndAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    pagesLimit: 12_000,
    pagesUsed: 0,
    monthlyPagesGrant: 12_000,
    monthlyPagesBalance: 12_000,
    addOnPagesBalance: 0,
    pagesConsumedThisCycle: 0,
    monthlyCreditsGrant: 40_000,
    monthlyCreditsBalance: 40_000,
    addOnCreditsBalance: 0,
    creditsReserved: 0,
    creditsConsumedThisCycle: 0,
    seatCount: 3,
    spendSoftCapUsd: null,
    spendHardCapUsd: null,
    createdAt: now,
    updatedAt: now,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_team_monthly",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const updates: Array<{
    externalSubscriptionId: string;
    externalProductId?: string | null;
    seatCount: number;
    updateBehavior: string;
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
      async updateSubscriptionSeats(input) {
        updates.push({
          externalSubscriptionId: input.externalSubscriptionId,
          externalProductId: input.externalProductId,
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
        });
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  const result = await billingService.syncTeamSubscriptionSeats("team_1", {
    seatCount: 5,
    actorUserId: "user_1",
  });

  assert.deepEqual(updates, [
    {
      externalSubscriptionId: "ext_sub_1",
      externalProductId: "prod_team_monthly",
      seatCount: 5,
      updateBehavior: "proration-charge-immediately",
    },
  ]);
  assert.equal(result.seatCount, 5);
  assert.equal(result.seatsUsed, 3);
  assert.equal(store.account?.seatCount, 5);
  // Per-member billing: a member's grant is one seat's worth and does NOT scale
  // with the team's seat count. Changing seats never re-grants existing members;
  // a new member gets their own per-seat allocation when their row is created.
  assert.equal(store.account?.monthlyCreditsGrant, 20_000);
  assert.equal(store.account?.monthlyPagesGrant, 6_000);

  const seatLedgers = store.ledgers.filter(
    (entry) => entry.unitType === "seat",
  );
  assert.equal(seatLedgers.length, 1);
  assert.equal(seatLedgers[0]?.eventType, "adjust");
  assert.equal(seatLedgers[0]?.feature, "seat_quota_change");
  assert.equal(seatLedgers[0]?.delta, 2);
  assert.equal(seatLedgers[0]?.balanceAfter, 5);
  assert.equal(seatLedgers[0]?.activityVisible, true);
  assert.equal(seatLedgers[0]?.activityTitle, "Seats updated");
  assert.equal(seatLedgers[0]?.activitySummary, "3 -> 5 seats");

  const seatOperationId = seatLedgers[0]?.operationId;
  assert.ok(seatOperationId);
  // No per-member quota grant on a seat change under per-member billing.
  const quotaLedgers = store.ledgers.filter(
    (entry) => entry.feature === "seat_quota_grant",
  );
  assert.equal(quotaLedgers.length, 0);
});

test("team subscription seat changes are visible per update without merging", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const now = new Date().toISOString();
  const periodEnd = new Date(Date.now() + 31 * 86_400_000).toISOString();
  store.account = {
    teamId: "team_1",
    userId: "user_1",
    planFamily: "team_standard",
    cycleAnchorAt: now,
    cycleSource: "provider_subscription",
    cycleStartAt: now,
    cycleEndAt: periodEnd,
    pagesLimit: 12_000,
    pagesUsed: 0,
    monthlyPagesGrant: 12_000,
    monthlyPagesBalance: 12_000,
    addOnPagesBalance: 0,
    pagesConsumedThisCycle: 0,
    monthlyCreditsGrant: 40_000,
    monthlyCreditsBalance: 40_000,
    addOnCreditsBalance: 0,
    creditsReserved: 0,
    creditsConsumedThisCycle: 0,
    seatCount: 2,
    spendSoftCapUsd: null,
    spendHardCapUsd: null,
    createdAt: now,
    updatedAt: now,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_team_monthly",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  await billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 3 });
  await billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 4 });
  await billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 2 });

  const seatLedgers = store.ledgers.filter(
    (entry) => entry.unitType === "seat",
  );
  assert.equal(seatLedgers.length, 3);
  assert.deepEqual(
    seatLedgers.map((entry) => entry.activitySummary),
    ["2 -> 3 seats", "3 -> 4 seats", "4 -> 2 seats"],
  );
  assert.deepEqual(
    seatLedgers.map((entry) => entry.delta),
    [1, 1, -2],
  );

  const activity = await billingService.getLedger("team_1", 20, {
    activityOnly: true,
  });
  const seatActivity = activity.items.filter(
    (entry) => entry.unitType === "seat",
  );
  assert.equal(seatActivity.length, 3);
  assert.ok(activity.items.every((entry) => entry.activityVisible));

  const visibleByOperation = new Map<string, number>();
  for (const entry of activity.items) {
    if (!entry.operationId) {
      continue;
    }

    visibleByOperation.set(
      entry.operationId,
      (visibleByOperation.get(entry.operationId) ?? 0) + 1,
    );
  }

  assert.ok([...visibleByOperation.values()].every((count) => count === 1));
  assert.ok(
    store.ledgers
      .filter(
        (entry) =>
          entry.operationType === "seat_change" && entry.unitType !== "seat",
      )
      .every((entry) => entry.activityVisible === false),
  );
});

test("team subscription seat downgrade fully claws back unused monthly quota", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const nowMs = Date.now();
  const periodStart = new Date(nowMs - 15 * 86_400_000).toISOString();
  const periodEnd = new Date(nowMs + 15 * 86_400_000).toISOString();
  store.account = createActiveTeamAccount({
    cycleStartAt: periodStart,
    cycleEndAt: periodEnd,
    seatCount: 3,
    monthlyCreditsGrant: 60_000,
    monthlyCreditsBalance: 60_000,
    monthlyPagesGrant: 18_000,
    monthlyPagesBalance: 18_000,
    pagesLimit: 18_000,
  });
  store.subscription = createActiveTeamSubscription({
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  const updates: Array<{ seatCount: number; updateBehavior: string }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        updates.push({
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
        });
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  const preview = await billingService.previewTeamSubscriptionSeats("team_1", {
    seatCount: 2,
  });
  // Per-member billing: a seat downgrade reclaims no shared quota (there is no
  // pool) — a removed seat removes that member's row. Only the seat's money is
  // refunded, at full proration.
  assert.equal(preview.quotaAdjustment, null);
  assert.equal(preview.billingAdjustment?.providerAction, "proration_credit");

  const result = await billingService.syncTeamSubscriptionSeats("team_1", {
    seatCount: 2,
    actorUserId: "user_1",
  });

  assert.deepEqual(updates, [
    {
      seatCount: 2,
      updateBehavior: "proration-charge",
    },
  ]);
  assert.equal(result.seatCount, 2);
  assert.equal(store.account?.seatCount, 2);
  // Per-member grant is one seat's worth and is not scaled or clawed back by the
  // team seat count; the member's balance is untouched by the seat change.
  assert.equal(store.account?.monthlyCreditsGrant, 20_000);
  assert.equal(store.account?.monthlyCreditsBalance, 60_000);
  assert.equal(store.account?.monthlyPagesGrant, 6_000);
  assert.equal(store.account?.monthlyPagesBalance, 18_000);
  assert.equal(
    store.ledgers.some((entry) => entry.feature === "seat_quota_clawback"),
    false,
  );
});

test("team subscription seat upgrade preview includes prorated charge", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const nowMs = Date.now();
  const periodStart = new Date(nowMs - 15 * 86_400_000).toISOString();
  const periodEnd = new Date(nowMs + 15 * 86_400_000).toISOString();
  store.account = createActiveTeamAccount({
    cycleStartAt: periodStart,
    cycleEndAt: periodEnd,
    seatCount: 2,
  });
  store.subscription = createActiveTeamSubscription({
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );

  const preview = await billingService.previewTeamSubscriptionSeats("team_1", {
    seatCount: 4,
  });

  assert.equal(preview.quotaAdjustment, null);
  assert.equal(
    preview.billingAdjustment?.providerAction,
    "proration_charge_immediately",
  );
  assert.equal(preview.billingAdjustment?.theoreticalRefundCents, 0);
  assert.equal(preview.billingAdjustment?.actualRefundCents, 0);
  assert.equal(preview.billingAdjustment?.unrefundedCents, 0);
  assert.ok((preview.billingAdjustment?.estimatedChargeCents ?? 0) > 4_800);
  assert.ok((preview.billingAdjustment?.estimatedChargeCents ?? 0) <= 4_900);
});

test("team subscription seat downgrade refunds in full regardless of a member's spend", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const nowMs = Date.now();
  const periodStart = new Date(nowMs - 15 * 86_400_000).toISOString();
  const periodEnd = new Date(nowMs + 15 * 86_400_000).toISOString();
  store.account = createActiveTeamAccount({
    cycleStartAt: periodStart,
    cycleEndAt: periodEnd,
    seatCount: 3,
    monthlyCreditsGrant: 60_000,
    monthlyCreditsBalance: 5_000,
    addOnCreditsBalance: 8_000,
    monthlyPagesGrant: 18_000,
    monthlyPagesBalance: 3_000,
    addOnPagesBalance: 1_000,
    pagesLimit: 18_000,
  });
  store.subscription = createActiveTeamSubscription({
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  const updates: Array<{ seatCount: number; updateBehavior: string }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        updates.push({
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
        });
        return {
          provider: "creem",
          seatCount: input.seatCount,
        };
      },
    },
  );

  const preview = await billingService.previewTeamSubscriptionSeats("team_1", {
    seatCount: 2,
  });
  // Per-member billing: no shared quota to reclaim, so a member's already-spent
  // balance no longer reduces the seat refund — the removed seat is refunded at
  // full proration and the member's balances are left untouched.
  assert.equal(preview.quotaAdjustment, null);
  assert.equal(preview.billingAdjustment?.providerAction, "proration_credit");

  const result = await billingService.syncTeamSubscriptionSeats("team_1", {
    seatCount: 2,
    actorUserId: "user_1",
  });

  assert.deepEqual(updates, [
    {
      seatCount: 2,
      updateBehavior: "proration-charge",
    },
  ]);
  assert.equal(result.billingAdjustment?.providerAction, "proration_credit");
  assert.equal(store.account?.monthlyCreditsBalance, 5_000);
  assert.equal(store.account?.addOnCreditsBalance, 8_000);
  assert.equal(store.account?.monthlyPagesBalance, 3_000);
  assert.equal(store.account?.addOnPagesBalance, 1_000);
  assert.equal(
    result.billingAdjustment?.actualRefundCents,
    result.billingAdjustment?.theoreticalRefundCents,
  );
});

test("team subscription seat downgrade is blocked by occupied member and invite seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 3;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({
    seatCount: 3,
    monthlyCreditsGrant: 60_000,
    monthlyPagesGrant: 18_000,
    pagesLimit: 18_000,
  });
  store.subscription = createActiveTeamSubscription();
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  );

  await assertRejectsWithBillingCode(
    () =>
      billingService.previewTeamSubscriptionSeats("team_1", { seatCount: 2 }),
    "SEAT_COUNT_FILLED_BY_MEMBERS",
  );

  store.teamMemberCount = 2;

  await assertRejectsWithBillingCode(
    () =>
      billingService.previewTeamSubscriptionSeats("team_1", { seatCount: 2 }),
    "SEAT_COUNT_BELOW_ALLOCATED_SEATS",
  );
});

test("creem seat update item includes product or price when updating units", () => {
  assert.deepEqual(
    resolveCreemSubscriptionSeatUpdateItem({
      subscription: {
        product: { id: "prod_team_monthly" },
        items: [{ id: "item_1", units: 3 }],
      },
      seatCount: 5,
    }),
    {
      id: "item_1",
      productId: "prod_team_monthly",
      units: 5,
    },
  );

  assert.deepEqual(
    resolveCreemSubscriptionSeatUpdateItem({
      subscription: {
        product: { id: "prod_team_monthly" },
        items: [{ id: "item_1", price_id: "price_team_monthly", units: 3 }],
      },
      seatCount: 6,
    }),
    {
      id: "item_1",
      productId: "prod_team_monthly",
      priceId: "price_team_monthly",
      units: 6,
    },
  );
});

test("team subscription seat sync failure leaves local seat count unchanged", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  const now = new Date().toISOString();
  await new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  ).ensureBillingAccount("team_1", "user_1");
  assert.ok(store.account);
  store.account = {
    ...store.account,
    planFamily: "team_standard",
    seatCount: 2,
    monthlyCreditsGrant: 40_000,
    monthlyPagesGrant: 12_000,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_team_monthly",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const alerts: Array<Record<string, unknown>> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats() {
        throw new Error("provider down");
      },
    },
    {
      async trigger(input) {
        alerts.push(input);
      },
      async resolve() {},
    },
  );

  await assert.rejects(
    () => billingService.syncTeamSubscriptionSeats("team_1", { seatCount: 4 }),
    /provider down/,
  );
  assert.equal(store.account?.seatCount, 2);
  assert.equal(store.account?.monthlyCreditsGrant, 40_000);
  assert.equal(store.account?.monthlyPagesGrant, 12_000);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.alertKey, "billing:seat-sync:failed:team_1");
});

test("team subscription member sync ignores pending invitations", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 2 });
  store.subscription = createActiveTeamSubscription();
  const updates: Array<{ seatCount: number; updateBehavior: string }> = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        updates.push({
          seatCount: input.seatCount,
          updateBehavior: input.updateBehavior,
        });
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  const result = await billingService.syncTeamSubscriptionSeatsToMembers(
    "team_1",
    { reason: "invitation_created" },
  );

  assert.equal(result, null);
  assert.equal(store.account?.seatCount, 2);
  assert.deepEqual(updates, []);

  store.pendingInvitationCount = 0;
  const noDowngrade = await billingService.syncTeamSubscriptionSeatsToMembers(
    "team_1",
    { reason: "invitation_revoked" },
  );

  assert.equal(noDowngrade, null);
  assert.equal(store.account?.seatCount, 2);
  assert.equal(updates.length, 0);
});

test("active team subscription rejects invitations at allocated seat capacity", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  const now = new Date().toISOString();
  await new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    noopProvider,
  ).ensureBillingAccount("team_1", "user_1");
  assert.ok(store.account);
  store.account = {
    ...store.account,
    planFamily: "team_standard",
    seatCount: 3,
  };
  store.subscription = {
    id: "sub_1",
    teamId: "team_1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "monthly",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    externalCustomerId: "cus_1",
    externalSubscriptionId: "ext_sub_1",
    externalSubscriptionItemId: null,
    externalProductId: "prod_team_monthly",
    billingOrderId: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    lastEventAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const updates: number[] = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        updates.push(input.seatCount);
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  await assertRejectsWithBillingCode(
    () => billingService.assertCanInviteTeamMember("team_1"),
    "TEAM_SEAT_LIMIT_REACHED",
  );

  assert.equal(store.account?.seatCount, 3);
  assert.deepEqual(updates, []);
});

test("active team subscription accepts preallocated invitation without expanding seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 3 });
  store.subscription = createActiveTeamSubscription();
  const updates: number[] = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        updates.push(input.seatCount);
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  await billingService.assertCanAcceptTeamInvitation("team_1");

  assert.equal(store.account?.seatCount, 3);
  assert.deepEqual(updates, []);
});

test("active team subscription rejects direct member add when invites occupy remaining seats", async () => {
  const store = new MemoryBillingStore();
  store.teamMemberCount = 2;
  store.pendingInvitationCount = 1;
  store.account = createActiveTeamAccount({ seatCount: 3 });
  store.subscription = createActiveTeamSubscription();
  const updates: number[] = [];
  const billingService = new BillingService(
    store,
    {
      ...runtimeConfig,
      teamBillingEnabled: true,
      provider: "creem",
    },
    {
      ...noopProvider,
      async updateSubscriptionSeats(input) {
        updates.push(input.seatCount);
        return { provider: "creem", seatCount: input.seatCount };
      },
    },
  );

  await assertRejectsWithBillingCode(
    () => billingService.assertCanAddTeamMember("team_1"),
    "TEAM_SEAT_LIMIT_REACHED",
  );

  assert.equal(store.account?.seatCount, 3);
  assert.deepEqual(updates, []);
});
