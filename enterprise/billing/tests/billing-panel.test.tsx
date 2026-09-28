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
import { BillingPanel } from "../src/ui/billing-panel";
import {
  formatBillingStatus,
  formatFeatureName,
} from "../src/ui/billing-utils";
import type { BillingCopyFormat } from "../src/ui/use-billing-copy";
import type {
  BillingOrg,
  BillingSummary,
  BillingSubscription,
} from "../src/ui/types";

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
  percent: (value) =>
    i18nFormatNumber(value, "zh-CN", {
      maximumFractionDigits: 1,
      style: "percent",
    }),
};

// `billing-plan-action-controls.tsx` renders `useBillingPlanAction()`'s
// `actionLabel` ("Manage billing" / "Upgrade plan"), which is out of scope
// for this task (it lives in `use-billing-plan-action.ts`, not one of the
// two files this task localises). Mocked out so it can't leak English text
// into these assertions, mirroring the usage-panel test's approach.
vi.mock("../src/ui/billing-plan-action-controls", () => ({
  BillingPlanActionControls: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// ---- Fixtures -------------------------------------------------------------

function makeSummary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    teamId: "team-1",
    planFamily: "team_standard",
    billingMode: "enforced",
    cycleAnchorAt: "2026-09-01T00:00:00.000Z",
    cycleSource: "provider_subscription",
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
    // `limit` below `used` forces the seat-count effect to push
    // `targetSeatCount` above `seatsLimit` on first render, so the "Update
    // seats" button is enabled without simulating a text-input change.
    seats: {
      used: 3,
      limit: 2,
      remaining: 0,
      activeMembers: 3,
      pendingInvitations: 1,
    },
    spendLimits: { softCapUsd: null, hardCapUsd: null },
    ...overrides,
  } as BillingSummary;
}

function makeActiveSubscription(
  overrides: Partial<BillingSubscription> = {},
): BillingSubscription {
  return {
    teamId: "team-1",
    provider: "creem",
    planFamily: "team_standard",
    status: "active",
    billingInterval: "yearly",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    externalCustomerId: "cus_1",
    externalSubscriptionId: "sub_1",
    billingOrderId: "order_1",
    externalSubscriptionItemId: "item_1",
    lastEventAt: "2026-09-10T12:34:00.000Z",
    capabilities: {
      managePortal: true,
      cancelViaPortal: true,
      updateSeats: true,
    },
    ...overrides,
  } as BillingSubscription;
}

function makeFreeSubscription(
  overrides: Partial<BillingSubscription> = {},
): BillingSubscription {
  return {
    teamId: "team-1",
    provider: "none",
    planFamily: null,
    status: "inactive",
    billingInterval: "unknown",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    externalCustomerId: null,
    externalSubscriptionId: null,
    billingOrderId: null,
    externalSubscriptionItemId: null,
    lastEventAt: null,
    ...overrides,
  } as BillingSubscription;
}

const seatPreviewFixture = {
  teamId: "team-1",
  provider: "creem" as const,
  currentSeatCount: 5,
  seatCount: 3,
  seatsUsed: 3,
  pendingInvitations: 1,
  quotaAdjustment: {
    removedSeats: 2,
    remainingRatio: 0.6,
    targetCredits: 3000,
    actualCredits: 3200,
    targetPages: 600,
    actualPages: 620,
    creditRecoverRatio: 0.6,
    pageRecoverRatio: 0.6,
    refundRatio: 0.3456,
  },
  billingAdjustment: {
    theoreticalRefundCents: 12345,
    actualRefundCents: 6789,
    unrefundedCents: 1111,
    estimatedChargeCents: 0,
    currency: "USD",
    providerAction: "proration_credit" as const,
  },
};

function makeHost(overrides: Partial<BillingUiHost> = {}): BillingUiHost {
  return {
    locale: "zh-CN",
    authClient: {
      useActiveOrganization: () => ({
        data: {
          id: "team-1",
          name: "Acme",
          metadata: { sourceweft: { kind: "team" } },
        } satisfies BillingOrg,
      }),
      useListOrganizations: () => ({ data: [] }),
      getSession: async () => ({ data: null }),
    },
    billingClient: {
      getSummary: async () => makeSummary(),
      getSubscription: async () => makeActiveSubscription(),
      previewSubscriptionSeats: async () => seatPreviewFixture,
    } as unknown as BillingUiHost["billingClient"],
    billingCheckoutEnabled: true,
    OrgSwitcher: () => null,
    BillingPanelSkeleton: () => <p>skeleton</p>,
    UsagePanelSkeleton: () => null,
    SettingsSkeletonBlock: () => null,
    subscribeDashboardBillingSummaryRefresh: () => () => {},
    trackBeginCheckout: () => {},
    trackCheckoutError: () => {},
    trackBillingPortalOpened: () => {},
    trackPurchase: () => {},
    ...overrides,
  };
}

async function renderBillingPanel(host: BillingUiHost) {
  const container = document.createElement("div");
  // The seat-preview `Dialog` renders through a Radix portal into
  // `document.body`, outside `container` — attach `container` to the real
  // document so `document.body.textContent` (read via `.page` below) picks
  // up both the panel and the portalled dialog content once it opens.
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <BillingUiProvider value={host}>
        <BillingPanel />
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
    get page() {
      return document.body.textContent ?? "";
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ---- Rendered panel ---------------------------------------------------------

test("billing panel renders plan, seats and seat preview in zh-CN", async () => {
  const copy = getBillingCopy("zh-CN");

  // ---- Active-subscription state -----------------------------------------
  const activeHost = makeHost({
    billingClient: {
      getSummary: async () => makeSummary(),
      getSubscription: async () => makeActiveSubscription(),
      previewSubscriptionSeats: async () => seatPreviewFixture,
    } as unknown as BillingUiHost["billingClient"],
  });

  const active = await renderBillingPanel(activeHost);
  try {
    // Header, scope, plan.
    expect(active.page).toContain(copy.billing.title);
    expect(active.page).toContain(
      formatCopyLike(copy.billing.scopeTeam, { team: "Acme" }),
    );
    expect(active.page).toContain(copy.common.planNames.team_standard);
    expect(active.page).toContain(copy.common.cycle);
    expect(active.page).toContain(copy.common.credits);
    expect(active.page).toContain(copy.common.pages);

    // The cycle row's date range renders through the billing locale's
    // formatter (spec O2) — computed independently of `use-billing-copy.ts`
    // here, so a regression to an ambient/`undefined`-locale `Intl.*` call
    // fails this instead of passing by coincidence of the test runner's own
    // default locale.
    expect(active.page).toContain(zhCNFormat.date("2026-09-01T00:00:00.000Z"));

    // Subscription rows.
    expect(active.page).toContain(copy.billing.subscriptionTitle);
    expect(active.page).toContain(copy.common.status);
    expect(active.page).toContain(copy.billing.rows.billingCadence);
    expect(active.page).toContain(copy.billing.rows.renewal);
    expect(active.page).toContain(copy.billing.rows.lastUpdated);
    expect(active.page).toContain(copy.common.intervals.annual);
    expect(active.page).toContain(copy.billing.renewalAuto);
    // The subscription's "active" status renders its zh-CN label
    // (`common.subscriptionStatuses.active`), not the raw English enum
    // value `formatFeatureName` would otherwise Title-Case it to.
    expect(active.page).toContain(copy.common.subscriptionStatuses.active);
    // Another rendered date, this time from the "Last updated" row.
    expect(active.page).toContain(zhCNFormat.date("2026-09-10T12:34:00.000Z"));

    // Seats section.
    expect(active.page).toContain(copy.billing.seatsSectionTitle);
    expect(active.page).toContain(
      formatCopyLike(copy.billing.seatsUsedOfLimit, {
        used: zhCNFormat.number(3),
        limit: zhCNFormat.number(2),
      }),
    );
    expect(active.page).toContain(
      formatCopyLike(copy.billing.seatsRemaining, {
        count: zhCNFormat.number(0),
      }),
    );
    const seatsInput = active.container.querySelector(
      `[aria-label="${copy.billing.totalSeatsLabel}"]`,
    );
    expect(seatsInput).not.toBeNull();
    expect(active.page).toContain(copy.billing.seatsTotalSuffix);

    // Click "Update seats" to open the seat-preview dialog (the fixture's
    // `seats.limit` (2) is below `seats.used` (3), so the seat-count effect
    // already pushed `targetSeatCount` above `seatsLimit` on mount — no
    // input simulation needed to enable the button).
    const updateSeatsButton = Array.from(
      active.container.querySelectorAll("button"),
    ).find((button) => button.textContent === copy.billing.updateSeats);
    expect(updateSeatsButton).not.toBeUndefined();
    expect(updateSeatsButton?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      updateSeatsButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Seat-preview dialog (decrease: 5 -> 3 seats).
    expect(active.page).toContain(copy.billing.reviewSeatReduction);
    expect(active.page).toContain(
      formatCopyLike(copy.billing.seatChangeSummary, {
        current: zhCNFormat.number(5),
        next: zhCNFormat.number(3),
      }),
    );
    expect(active.page).toContain(
      formatCopyLike(copy.billing.seatChangeDetail, {
        used: zhCNFormat.number(3),
        pending: zhCNFormat.number(1),
      }),
    );
    expect(active.page).toContain(copy.billing.seatPreview.theoreticalRefund);
    expect(active.page).toContain(copy.billing.seatPreview.refundOrCredit);
    expect(active.page).toContain(copy.billing.seatPreview.notRefundable);
    expect(active.page).toContain(copy.billing.seatPreview.refundRatio);
    expect(active.page).toContain(copy.billing.seatPreview.creditsDeducted);
    expect(active.page).toContain(copy.billing.seatPreview.pagesDeducted);
    expect(active.page).toContain(copy.billing.seatPreview.billingAction);
    expect(active.page).toContain(
      copy.billing.seatProviderActions.proration_credit,
    );
    expect(active.page).toContain(copy.common.cancel);
    expect(active.page).toContain(copy.billing.confirmReduction);

    // A currency amount renders through the billing locale's formatter
    // (spec O2) — computed independently of `use-billing-copy.ts` here, so
    // a regression to an ambient/`undefined`-locale `Intl.*` call fails
    // this instead of passing by coincidence of the test runner's own
    // default locale.
    expect(active.page).toContain(zhCNFormat.currency(12345, "USD"));
    // A percent value, built on `format.percent` (new for this task). Unlike
    // the date/currency assertions above, this one is NOT a regression guard
    // against an ambient/`undefined`-locale call: a sub-100% percentage such
    // as "34.6%" formats identically in en-US and zh-CN (no locale-specific
    // grouping or symbol placement comes into play), so a `format.percent`
    // that silently fell back to the ambient locale would still pass this
    // assertion by coincidence. It does confirm `format.percent` exists and
    // renders the right numeric value.
    expect(active.page).toContain(zhCNFormat.percent(0.3456));

    // No hard-coded English leftovers from the pre-localisation copy. (The
    // Cycle row's detail legitimately still renders `formatFeatureName` of
    // the raw `cycleSource` enum ("Provider Subscription") — that beautifier
    // is out of this task's scope, matching the pattern already established
    // for ledger feature names, so "Subscription" alone isn't checked here.)
    expect(active.page).not.toContain("Billing");
    expect(active.page).not.toContain("Seats");
    expect(active.page).not.toContain("Cancel");
    expect(active.page).not.toContain("Update seats");
    expect(active.page).not.toContain("Review seat reduction");
    expect(active.page).not.toContain("Confirm reduction");
    expect(active.page).not.toContain("Theoretical refund");
    expect(active.page).not.toContain("Billing action");
    expect(active.page).not.toContain("Provider proration credit");
    // The English status label `formatFeatureName("active")` would have
    // produced before this fix round.
    expect(active.page).not.toContain("Active");
  } finally {
    await active.unmount();
  }

  // ---- Free (no paid subscription) state ---------------------------------
  const freeHost = makeHost({
    authClient: {
      useActiveOrganization: () => ({
        data: {
          id: "personal-1",
          name: "Alex",
          metadata: { sourceweft: { kind: "personal" } },
        } satisfies BillingOrg,
      }),
      useListOrganizations: () => ({ data: [] }),
      getSession: async () => ({ data: null }),
    },
    billingClient: {
      getSummary: async () => makeSummary({ planFamily: "individual_free" }),
      getSubscription: async () => makeFreeSubscription(),
    } as unknown as BillingUiHost["billingClient"],
    billingCheckoutEnabled: false,
  });

  const free = await renderBillingPanel(freeHost);
  try {
    expect(free.page).toContain(copy.billing.scopePersonal);
    expect(free.page).toContain(copy.common.planNames.individual_free);
    expect(free.page).toContain(
      formatCopyLike(copy.billing.planLabel, {
        plan: copy.common.planNames.individual_free,
      }),
    );
    expect(free.page).toContain(
      formatCopyLike(copy.billing.planAccount, {
        plan: copy.common.planNames.individual_free,
      }),
    );
    expect(free.page).toContain(copy.billing.noPaidSubscription);
    expect(free.page).toContain(copy.common.intervals.notSet);
    expect(free.page).toContain(copy.billing.renewalNotScheduled);
    expect(free.page).toContain(copy.billing.noSubscriptionUpdates);

    // Personal accounts never render the Seats section.
    expect(free.page).not.toContain(copy.billing.seatsSectionTitle);

    // No hard-coded English leftovers.
    expect(free.page).not.toContain("Personal billing");
    expect(free.page).not.toContain("No paid subscription");
    expect(free.page).not.toContain("Not scheduled");
    expect(free.page).not.toContain("No subscription updates yet");
  } finally {
    await free.unmount();
  }
});

// ---- formatBillingStatus lookup chain --------------------------------------

test("formatBillingStatus maps every known subscription status to its zh-CN label, and falls back to formatFeatureName for an unmapped one", () => {
  const copy = getBillingCopy("zh-CN");

  const knownStatuses = [
    "inactive",
    "trialing",
    "active",
    "past_due",
    "paused",
    "unpaid",
    "canceled",
    "expired",
  ] as const;
  for (const status of knownStatuses) {
    expect(formatBillingStatus(status, copy)).toBe(
      copy.common.subscriptionStatuses[status],
    );
  }

  // A status value the catalogue doesn't list (e.g. a future provider state
  // this catalogue hasn't caught up with yet) keeps the old
  // `formatFeatureName` beautifier instead of throwing or rendering nothing.
  expect(formatBillingStatus("some_future_status", copy)).toBe(
    formatFeatureName("some_future_status"),
  );
  expect(formatBillingStatus("some_future_status", copy)).toBe(
    "Some Future Status",
  );

  // A missing value still falls back to `common.unknown`, unchanged from
  // before this fix round.
  expect(formatBillingStatus(null, copy)).toBe(copy.common.unknown);
  expect(formatBillingStatus(undefined, copy)).toBe(copy.common.unknown);
});

/**
 * A local, test-only stand-in for `formatCopy` (kept independent of the
 * implementation under test's import of it), so assertions don't rely on
 * the very function `billing-panel.tsx` uses to build its own strings.
 */
function formatCopyLike(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : match,
  );
}
