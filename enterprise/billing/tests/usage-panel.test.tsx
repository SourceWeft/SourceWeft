// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import {
  formatDate as i18nFormatDate,
  formatNumber as i18nFormatNumber,
} from "@sourceweft/i18n";

import { getBillingCopy } from "../src/messages";
import { BillingUiProvider, type BillingUiHost } from "../src/ui/context";
import { UsagePanel } from "../src/ui/usage-panel";
import {
  formatLedgerActivityChange,
  formatLedgerDetail,
  formatLedgerUnit,
  formatUsageActivityDetail,
  getUsageActivityKind,
} from "../src/ui/billing-utils";
import type { BillingCopy } from "../src/messages";
import type { BillingCopyFormat } from "../src/ui/use-billing-copy";
import type { BillingLedgerEntry } from "../src/ui/types";

// A `BillingCopyFormat` built the same way `useBillingCopy()` builds one
// (same `@sourceweft/i18n` calls, same options), pinned to zh-CN. Used both
// to call functions that now require a `format` argument, and independently
// of `use-billing-copy.ts` to compute the expected rendered text — so a
// regression back to an ambient/`undefined`-locale `Intl.*` call would fail
// these assertions instead of passing by coincidence of the test runner's
// own default locale (spec O2).
const zhCNFormat: BillingCopyFormat = {
  number: (value) =>
    i18nFormatNumber(value, "zh-CN", { maximumFractionDigits: 0 }),
  date: (iso) =>
    i18nFormatDate(new Date(iso), "zh-CN", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    }),
  dateTime: (iso) =>
    i18nFormatDate(new Date(iso), "zh-CN", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
  currency: (cents, currency = "USD") =>
    i18nFormatNumber(cents / 100, "zh-CN", { style: "currency", currency }),
};

vi.mock("../src/ui/billing-plan-action-controls", () => ({
  BillingPlanActionControls: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// ---- Fixtures -------------------------------------------------------------

function makeEntry(
  overrides: Partial<BillingLedgerEntry> = {},
): BillingLedgerEntry {
  return {
    id: "entry-1",
    teamId: "team-1",
    workspaceId: null,
    actorUserId: null,
    feature: "cycle_grant",
    eventType: "grant",
    unitType: "credit",
    delta: 100,
    balanceAfter: 100,
    referenceId: null,
    idempotencyKey: null,
    operationId: null,
    operationType: "cycle_renewal",
    activityVisible: true,
    activityTitle: null,
    activitySummary: null,
    metadata: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSubscription() {
  return {
    teamId: "team-1",
    provider: "none" as const,
    planFamily: null,
    status: "inactive" as const,
    billingInterval: "unknown" as const,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    externalCustomerId: null,
    externalSubscriptionId: null,
    billingOrderId: null,
    externalSubscriptionItemId: null,
    lastEventAt: null,
  };
}

function makeHost(overrides: Partial<BillingUiHost> = {}): BillingUiHost {
  return {
    locale: "zh-CN",
    authClient: {
      useActiveOrganization: () => ({
        data: {
          id: "team-1",
          name: "Acme",
          metadata: { sourceweft: { kind: "team" } },
        },
      }),
      useListOrganizations: () => ({ data: [] }),
      getSession: async () => ({ data: null }),
    },
    billingClient: {
      getSummary: async () => makeSummary(),
      getSubscription: async () => makeSubscription(),
      getActivity: async () => ({
        teamId: "team-1",
        items: [],
        nextCursor: null,
      }),
    } as unknown as BillingUiHost["billingClient"],
    billingCheckoutEnabled: false,
    OrgSwitcher: () => null,
    BillingPanelSkeleton: () => null,
    UsagePanelSkeleton: () => <p>skeleton</p>,
    SettingsSkeletonBlock: () => null,
    subscribeDashboardBillingSummaryRefresh: () => () => {},
    trackBeginCheckout: () => {},
    trackCheckoutError: () => {},
    trackBillingPortalOpened: () => {},
    trackPurchase: () => {},
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<
    Awaited<ReturnType<BillingUiHost["billingClient"]["getSummary"]>>
  > = {},
) {
  return {
    teamId: "team-1",
    planFamily: "team_standard" as const,
    billingMode: "enforced" as const,
    cycleAnchorAt: "2026-09-01T00:00:00.000Z",
    cycleSource: "provider_subscription" as const,
    cycleStartAt: "2026-09-01T00:00:00.000Z",
    cycleEndAt: "2026-10-01T00:00:00.000Z",
    pages: {
      limit: 1000,
      used: 200,
      remaining: 800,
      monthlyGrant: 900,
      monthlyBalance: 700,
      addOnBalance: 100,
      consumedThisCycle: 200,
      available: 800,
    },
    credits: {
      monthlyGrant: 5000,
      monthlyBalance: 4000,
      addOnBalance: 0,
      reserved: 0,
      consumedThisCycle: 1000,
      available: 4000,
    },
    seats: {
      used: 3,
      limit: 5,
      remaining: 2,
      activeMembers: 3,
      pendingInvitations: 0,
    },
    spendLimits: { softCapUsd: null, hardCapUsd: null },
    ...overrides,
  };
}

async function renderUsagePanel(host: BillingUiHost) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <BillingUiProvider value={host}>
        <UsagePanel />
      </BillingUiProvider>,
    );
  });
  // Let the effect's promises resolve and flush the resulting state update.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    unmount: () => act(async () => root.unmount()),
  };
}

// ---- formatLedgerDetail lookup chain --------------------------------------

test("activity rows render in zh-CN for known features, including rows written before localisation", () => {
  const copy = getBillingCopy("zh-CN");

  // A fresh row (no stored activityTitle) for a known grant feature.
  expect(
    formatLedgerDetail(
      makeEntry({
        eventType: "grant",
        feature: "cycle_grant",
        unitType: "credit",
      }),
      copy,
    ),
  ).toBe(copy.activity.grant.cycle_grant.credit);

  // "Old" rows written before this catalogue existed already carry an
  // English `activityTitle` — the catalogue must still win for known
  // features (Review Focus 3), not the stored English text.
  expect(
    formatLedgerDetail(
      makeEntry({
        eventType: "grant",
        feature: "cycle_grant",
        unitType: "credit",
        activityTitle: "Monthly quota renewed",
      }),
      copy,
    ),
  ).toBe(copy.activity.grant.cycle_grant.credit);
  expect(
    formatLedgerDetail(
      makeEntry({
        eventType: "adjust",
        feature: "seat_quota_change",
        unitType: "seat",
        activityTitle: "Seats updated",
      }),
      copy,
    ),
  ).toBe(copy.activity.adjust.seat_quota_change.seat);
  expect(
    formatLedgerDetail(
      makeEntry({
        eventType: "consume",
        feature: "ingestion",
        unitType: "page",
        activityTitle: "Pages indexed",
      }),
      copy,
    ),
  ).toBe(copy.activity.consume.ingestion.page);

  // Open-ended "model-usage consume" features are also a *known* bucket —
  // they localise through `activity.consume.default`, not through the
  // (currently mislabeled) stored English title.
  expect(
    formatLedgerDetail(
      makeEntry({
        eventType: "consume",
        feature: "retrieval",
        unitType: "credit",
        activityTitle: "Chat credits used",
      }),
      copy,
    ),
  ).toBe("Retrieval 积分已使用");
  expect(
    formatLedgerDetail(
      makeEntry({
        eventType: "consume",
        feature: "source_ingestion",
        unitType: "page",
        activityTitle: "Pages indexed",
      }),
      copy,
    ),
  ).toBe("Source Ingestion 页面已使用");
});

test("an unknown feature falls back to its stored English title", () => {
  const copy = getBillingCopy("zh-CN");
  // Simulate a catalogue that genuinely has no entry for this event type at
  // all (no specific key, no `default`) — the only way an "unknown
  // feature" can occur, since every real `LedgerEventType` ships a
  // `default`. This exercises the third tier of the fallback chain.
  const brokenCopy = {
    ...copy,
    activity: { ...copy.activity, reserve: {} },
  } as unknown as BillingCopy;

  const entry = makeEntry({
    eventType: "reserve",
    feature: "future_reserve_feature",
    unitType: "credit",
    activityTitle: "Credits reserved (English)",
  });

  expect(formatLedgerDetail(entry, brokenCopy)).toBe(
    "Credits reserved (English)",
  );
});

test("formatLedgerDetail falls back to a generic, still-localised composition when even the stored title is missing", () => {
  const copy = getBillingCopy("zh-CN");
  const brokenCopy = {
    ...copy,
    activity: { ...copy.activity, reserve: {} },
  } as unknown as BillingCopy;

  const entry = makeEntry({
    eventType: "reserve",
    feature: "future_reserve_feature",
    unitType: "credit",
    activityTitle: null,
  });

  expect(formatLedgerDetail(entry, brokenCopy)).toBe(
    formatUsageActivityDetail(
      getUsageActivityKind(entry),
      "Future Reserve Feature",
      copy,
    ),
  );
});

test("formatLedgerUnit returns the catalogue's localized plural", () => {
  const copy = getBillingCopy("zh-CN");
  expect(formatLedgerUnit("credit", copy)).toBe(copy.common.units.credit);
  expect(formatLedgerUnit("page", copy)).toBe(copy.common.units.page);
  expect(formatLedgerUnit("seat", copy)).toBe(copy.common.units.seat);
});

test("formatLedgerActivityChange composes from structured fields and ignores any stored English summary", () => {
  const copy = getBillingCopy("zh-CN");
  // Consume/grant rows compose from delta/balance, even though the server
  // also wrote an English `activitySummary` (`formatSignedLedgerDelta`).
  expect(
    formatLedgerActivityChange(
      makeEntry({
        delta: -5,
        balanceAfter: 95,
        unitType: "credit",
        activitySummary: "-5 credits",
      }),
      copy,
      zhCNFormat,
    ),
  ).toBe("-5 积分 · 剩余 95");
  // Plan-change grants store an English "Free -> Pro" plan-name arrow as
  // their `activitySummary` (account-service.ts) — still ignored.
  expect(
    formatLedgerActivityChange(
      makeEntry({
        eventType: "grant",
        feature: "plan_upgrade_grant",
        unitType: "credit",
        delta: 200,
        balanceAfter: 700,
        activitySummary: "Free -> Pro",
      }),
      copy,
      zhCNFormat,
    ),
  ).toBe("+200 积分 · 剩余 700");
  // Seat rows use the dedicated previous/next composition instead of the
  // delta/balance phrasing, and ignore the server's "150 -> 200 seats".
  expect(
    formatLedgerActivityChange(
      makeEntry({
        unitType: "seat",
        delta: 50,
        balanceAfter: 200,
        activitySummary: "150 -> 200 seats",
      }),
      copy,
      zhCNFormat,
    ),
  ).toBe("150 → 200 席位");
  // A grouped number (thousands separator) also goes through the real
  // `@sourceweft/i18n` formatter — not an ambient/`undefined`-locale
  // `Intl.NumberFormat`.
  expect(
    formatLedgerActivityChange(
      makeEntry({ delta: 12345, balanceAfter: 12345, unitType: "credit" }),
      copy,
      zhCNFormat,
    ),
  ).toBe(
    `+${zhCNFormat.number(12345)} 积分 · 剩余 ${zhCNFormat.number(12345)}`,
  );
});

// ---- Rendered panel ---------------------------------------------------------

test("known activity rows, including rows written before localisation, render in zh-CN", async () => {
  const ledgerEntries: BillingLedgerEntry[] = [
    makeEntry({
      id: "row-1",
      eventType: "grant",
      feature: "cycle_grant",
      unitType: "credit",
      // A grouped number (thousands separator), to prove the balance
      // renders through the billing locale's formatter, not an
      // ambient/`undefined`-locale one.
      delta: 12345,
      balanceAfter: 12345,
      activityTitle: "Monthly quota renewed",
      createdAt: "2026-09-05T00:00:00.000Z",
    }),
    makeEntry({
      id: "row-2",
      eventType: "adjust",
      feature: "seat_quota_change",
      unitType: "seat",
      delta: 50,
      balanceAfter: 200,
      activityTitle: "Seats updated",
      // Server-composed English summary (account-service.ts) — must never
      // leak through the "Usage" column.
      activitySummary: "150 -> 200 seats",
      createdAt: "2026-09-06T00:00:00.000Z",
    }),
    makeEntry({
      id: "row-3",
      eventType: "consume",
      feature: "retrieval",
      unitType: "credit",
      delta: -5,
      balanceAfter: 995,
      activityTitle: "Chat credits used",
      // formatSignedLedgerDelta-style English summary — ignored too.
      activitySummary: "-5 credits",
      createdAt: "2026-09-07T00:00:00.000Z",
    }),
    makeEntry({
      id: "row-4",
      eventType: "grant",
      feature: "plan_upgrade_grant",
      unitType: "credit",
      delta: 200,
      balanceAfter: 700,
      // Plan-name arrow (account-service.ts:327) — ignored, per the
      // consume/grant delta/balance composition.
      activitySummary: "Free -> Pro",
      createdAt: "2026-09-08T00:00:00.000Z",
    }),
  ];
  const host = makeHost({
    billingClient: {
      getSummary: async () => makeSummary(),
      getSubscription: async () => makeSubscription(),
      getActivity: async () => ({
        teamId: "team-1",
        items: ledgerEntries,
        nextCursor: null,
      }),
    } as unknown as BillingUiHost["billingClient"],
  });

  const { container, unmount } = await renderUsagePanel(host);
  try {
    const copy = getBillingCopy("zh-CN");
    expect(container.textContent).toContain(
      copy.activity.grant.cycle_grant.credit,
    );
    expect(container.textContent).toContain(
      copy.activity.adjust.seat_quota_change.seat,
    );
    expect(container.textContent).toContain("Retrieval 积分已使用");
    // The stored English titles from before localisation must not leak
    // through for these known features.
    expect(container.textContent).not.toContain("Monthly quota renewed");
    expect(container.textContent).not.toContain("Seats updated");
    expect(container.textContent).not.toContain("Chat credits used");

    // The "Usage" (Δ) column renders from the structured ledger fields,
    // localised — never the server's stored English `activitySummary`.
    expect(container.textContent).toContain("150 → 200 席位");
    expect(container.textContent).toContain("-5 积分 · 剩余 995");
    expect(container.textContent).toContain("+200 积分 · 剩余 700");
    expect(container.textContent).not.toContain("150 -> 200 seats");
    expect(container.textContent).not.toContain("-5 credits");
    expect(container.textContent).not.toContain("Free -> Pro");

    // Numbers and dates go through `@sourceweft/i18n` with the billing
    // locale (spec O2) — computed independently of `use-billing-copy.ts`
    // here, so a regression to an ambient/`undefined`-locale `Intl.*` call
    // fails these instead of passing by coincidence of the test runner's
    // own default locale.
    expect(container.textContent).toContain(
      zhCNFormat.dateTime("2026-09-05T00:00:00.000Z"),
    );
    expect(container.textContent).toContain(zhCNFormat.number(12345));
  } finally {
    await unmount();
  }
});

test("usage labels and empty states render in zh-CN", async () => {
  const host = makeHost({
    billingClient: {
      getSummary: async () => makeSummary(),
      getSubscription: async () => makeSubscription(),
      getActivity: async () => ({
        teamId: "team-1",
        items: [],
        nextCursor: null,
      }),
    } as unknown as BillingUiHost["billingClient"],
  });

  const { container, unmount } = await renderUsagePanel(host);
  try {
    const copy = getBillingCopy("zh-CN");
    expect(container.textContent).toContain(copy.usage.title);
    expect(container.textContent).toContain(copy.usage.activityTitle);
    expect(container.textContent).toContain(copy.common.credits);
    expect(container.textContent).toContain(copy.common.pages);
    expect(container.textContent).toContain(copy.common.seats);
    expect(container.textContent).toContain(copy.usage.table.detail);
    expect(container.textContent).toContain(copy.usage.table.date);
    expect(container.textContent).toContain(copy.usage.table.usage);
    expect(container.textContent).toContain(copy.usage.noActivity);
    expect(container.textContent).toContain(
      copy.common.planNames.team_standard,
    );

    const filterGroup = container.querySelector(
      `[aria-label="${copy.usage.filterAriaLabel}"]`,
    );
    expect(filterGroup).not.toBeNull();
    expect(filterGroup?.textContent).toContain(copy.usage.filters.all);
    expect(filterGroup?.textContent).toContain(copy.usage.filters.seat);
    expect(filterGroup?.textContent).toContain(copy.usage.filters.page);
    expect(filterGroup?.textContent).toContain(copy.usage.filters.credit);

    // No hard-coded English leftovers from the pre-localisation copy.
    expect(container.textContent).not.toContain("Usage");
    expect(container.textContent).not.toContain("Activity");
    expect(container.textContent).not.toContain("Detail");
    expect(container.textContent).not.toContain("No usage activity yet");
    expect(container.textContent).not.toContain("Load more");

    // Filtering to a unit with no matching rows renders the localized
    // per-unit empty state.
    const seatFilterButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === copy.usage.filters.seat);
    expect(seatFilterButton).not.toBeUndefined();
    await act(async () => {
      seatFilterButton?.click();
    });
    expect(container.textContent).toContain(
      copy.usage.noActivityForUnit.replace("{unit}", copy.common.units.seat),
    );
  } finally {
    await unmount();
  }
});
