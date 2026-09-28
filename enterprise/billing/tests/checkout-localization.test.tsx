// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { toast } from "sonner";
import {
  formatDate as i18nFormatDate,
  formatNumber as i18nFormatNumber,
} from "@sourceweft/i18n";

import {
  getBillingControls,
  getBillingCopy,
  formatCopy,
} from "../src/messages";
import { BillingUiProvider, type BillingUiHost } from "../src/ui/context";
import { TeamCheckoutDialog } from "../src/ui/team-checkout-dialog";
import { BillingCheckoutClient } from "../src/ui/billing-checkout-client";
import { BillingSuccessClient } from "../src/ui/billing-success-client";
import { SidebarUsageSummary } from "../src/ui/sidebar-usage";
import { TopupActions } from "../src/ui/topup-actions";
import type { BillingCopyFormat } from "../src/ui/use-billing-copy";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/link", () => ({
  default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} />
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A `BillingCopyFormat` built the same way `useBillingCopy()` builds one (same
// `@sourceweft/i18n` calls, same options), pinned to zh-CN. Used both to
// compute expected rendered text independently of `use-billing-copy.ts`, so a
// regression to an ambient/`undefined`-locale `Intl.*` call fails these
// instead of passing by coincidence of the test runner's own default locale
// (spec O2) — same pattern as `usage-panel.test.tsx`/`billing-panel.test.tsx`,
// extended with the two new members this task adds.
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
  compactNumber: (value) =>
    i18nFormatNumber(value, "zh-CN", {
      maximumFractionDigits: 1,
      notation: "compact",
    }),
  shortDate: (iso) =>
    i18nFormatDate(new Date(iso), "zh-CN", { day: "numeric", month: "short" }),
};

/**
 * A local, test-only stand-in for `formatCopy` (kept independent of the
 * implementation under test's import of it), matching the pattern
 * `billing-panel.test.tsx` established.
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

function makeHost(overrides: Partial<BillingUiHost> = {}): BillingUiHost {
  return {
    locale: "zh-CN",
    authClient: {
      useActiveOrganization: () => ({ data: null }),
      useListOrganizations: () => ({ data: [] }),
      getSession: async () => ({ data: null }),
    },
    billingClient: {} as unknown as BillingUiHost["billingClient"],
    billingCheckoutEnabled: true,
    OrgSwitcher: () => null,
    BillingPanelSkeleton: () => null,
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

async function renderNode(node: React.ReactNode) {
  const container = document.createElement("div");
  // Dialog content renders through a Radix portal into `document.body`, not
  // into the React root's own container (confirmed in `billing-panel.test.tsx`)
  // — attach `container` to the real document so `.page` (reading
  // `document.body.textContent`) picks up both the panel and any portalled
  // dialog content.
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
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

// ---- Team checkout dialog, checkout success page, sidebar usage ----------

test("checkout dialog, success page and sidebar usage render in zh-CN", async () => {
  const copy = getBillingCopy("zh-CN");
  const controls = getBillingControls("zh-CN");

  // ---- Team checkout dialog ------------------------------------------------
  vi.mocked(toast.error).mockClear();
  const dialogHost = makeHost({
    billingClient: {
      createPricingCheckout: vi.fn(),
    } as unknown as BillingUiHost["billingClient"],
  });
  const dialog = await renderNode(
    <BillingUiProvider value={dialogHost}>
      <TeamCheckoutDialog
        allowBillingIntervalSwitch
        billingInterval="yearly"
        monthlyPerSeatPrice={2500}
        onOpenChange={() => {}}
        open
        perSeatPrice={2000}
        source="landing"
        yearlyPerSeatPrice={2000}
      />
    </BillingUiProvider>,
  );
  try {
    expect(dialog.page).toContain(copy.checkout.createTeam);
    expect(dialog.page).toContain(copy.checkout.createTeamDescription);
    expect(dialog.page).toContain(copy.checkout.teamNameLabel);
    expect(dialog.page).toContain(copy.common.seats);
    expect(dialog.page).toContain(copy.checkout.billingLabel);
    expect(dialog.page).toContain(controls.yearly);
    expect(dialog.page).toContain(controls.monthly);
    expect(dialog.page).toContain(copy.checkout.saveTwoMonths);
    expect(dialog.page).toContain(copy.checkout.total);
    expect(dialog.page).toContain(copy.common.cancel);
    expect(dialog.page).toContain(copy.checkout.continue);

    // `TeamCheckoutDialog`'s content renders through a Radix portal into
    // `document.body`, not into `dialog.container` (confirmed in
    // `billing-panel.test.tsx`) — element queries go through `document.body`.
    const nameInput = document.body.querySelector(
      `#${document.body.querySelector("label")?.getAttribute("for")}`,
    ) as HTMLInputElement | null;
    expect(nameInput?.placeholder).toBe(copy.checkout.teamNamePlaceholder);

    expect(dialog.page).toContain(
      formatCopyLike(copy.checkout.perSeatSummary, {
        price: "$20",
        count: zhCNFormat.number(2),
      }),
    );

    // Submitting with an empty team name (dispatching `submit` directly
    // bypasses the input's native `required` validation, same technique
    // `fireEvent.submit` uses) shows the localized validation toast.
    const form = document.body.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(toast.error).toHaveBeenCalledWith(copy.checkout.enterTeamName);

    // A valid name with an out-of-range seat count (set via a raw `change`,
    // which the component does not clamp until `blur`) shows the localized
    // range message.
    vi.mocked(toast.error).mockClear();
    const teamNameField = document.body.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    const seatsField = document.body.querySelector(
      "input[type='number']",
    ) as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeSetter?.call(teamNameField, "Acme");
      teamNameField.dispatchEvent(new Event("input", { bubbles: true }));
      nativeSetter?.call(seatsField, "1");
      seatsField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(toast.error).toHaveBeenCalledWith(
      formatCopyLike(copy.checkout.seatsRange, { min: 2, max: 99 }),
    );

    // No hard-coded English leftovers.
    expect(dialog.page).not.toContain("Create team");
    expect(dialog.page).not.toContain("Team name");
    expect(dialog.page).not.toContain("Seats");
    expect(dialog.page).not.toContain("Billing");
    expect(dialog.page).not.toContain("Checkout total");
    expect(dialog.page).not.toContain("Cancel");
    expect(dialog.page).not.toContain("Continue to checkout");
    expect(dialog.page).not.toContain("Yearly");
    expect(dialog.page).not.toContain("Monthly");
    expect(dialog.page).not.toContain("Save 2 months");
  } finally {
    await dialog.unmount();
  }

  // ---- Billing checkout client: invalid link -------------------------------
  const invalidLinkHost = makeHost({
    billingClient: {
      createPricingCheckout: vi.fn(),
    } as unknown as BillingUiHost["billingClient"],
  });
  const invalidLink = await renderNode(
    <BillingUiProvider value={invalidLinkHost}>
      <BillingCheckoutClient
        billingInterval="monthly"
        intent="abc"
        plan="not-a-plan"
        seatCount={null}
        source="landing"
        teamName={null}
      />
    </BillingUiProvider>,
  );
  try {
    expect(invalidLink.page).toContain(copy.checkout.needsAttention);
    expect(invalidLink.page).toContain(copy.checkout.invalidLink);
    expect(invalidLink.page).toContain(copy.checkout.tryAgain);
    expect(invalidLink.page).toContain(copy.checkout.backToPricing);
    expect(invalidLink.page).not.toContain("Checkout needs attention");
    expect(invalidLink.page).not.toContain(
      "This checkout link is no longer valid.",
    );
  } finally {
    await invalidLink.unmount();
  }

  // ---- Billing checkout client: invalid team seat count ---------------------
  const invalidSeatsHost = makeHost({
    billingClient: {
      createPricingCheckout: vi.fn(),
    } as unknown as BillingUiHost["billingClient"],
  });
  const invalidSeats = await renderNode(
    <BillingUiProvider value={invalidSeatsHost}>
      <BillingCheckoutClient
        billingInterval="monthly"
        intent="abc"
        plan="team"
        seatCount="1"
        source="landing"
        teamName="Acme"
      />
    </BillingUiProvider>,
  );
  try {
    expect(invalidSeats.page).toContain(copy.checkout.invalidSeatCount);
    expect(invalidSeats.page).not.toContain(
      "This team checkout link has an invalid seat count.",
    );
  } finally {
    await invalidSeats.unmount();
  }

  // ---- Billing checkout client: preparing state ------------------------------
  let resolveCheckout: (value: {
    provider: string;
    checkoutUrl: string;
    grantedCredits?: number;
  }) => void = () => {};
  const pendingCheckout = new Promise<{
    provider: string;
    checkoutUrl: string;
    grantedCredits?: number;
  }>((resolve) => {
    resolveCheckout = resolve;
  });
  const preparingHost = makeHost({
    billingClient: {
      createPricingCheckout: vi.fn(() => pendingCheckout),
    } as unknown as BillingUiHost["billingClient"],
  });
  const preparing = await renderNode(
    <BillingUiProvider value={preparingHost}>
      <BillingCheckoutClient
        billingInterval="monthly"
        intent="abc"
        plan="pro"
        seatCount={null}
        source="landing"
        teamName={null}
      />
    </BillingUiProvider>,
  );
  try {
    expect(preparing.page).toContain(copy.checkout.opening);
    expect(preparing.page).toContain(
      formatCopyLike(copy.checkout.preparingDescription, {
        plan: copy.checkout.planPro,
      }),
    );

    // Resolving with a waffo checkout opens the shared Secure-payment dialog
    // (`context.tsx`), which renders through the same provider tree.
    await act(async () => {
      resolveCheckout({
        provider: "waffo",
        checkoutUrl: "https://pay.waffo.test/session",
        grantedCredits: 12345,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(preparing.page).toContain(copy.checkout.openingDescription);
    expect(preparing.page).toContain(copy.checkout.securePaymentTitle);
    expect(preparing.page).toContain(
      formatCopyLike(copy.checkout.waffoCreditsDescription, {
        count: zhCNFormat.number(12345),
      }),
    );
    expect(preparing.page).toContain(copy.checkout.openCheckout);
    expect(preparing.page).not.toContain("Secure payment");
    expect(preparing.page).not.toContain("Open checkout");
    expect(preparing.page).not.toContain(
      "Open Waffo checkout in a new tab to review the total and pay.",
    );
  } finally {
    await preparing.unmount();
  }

  // ---- Billing checkout client: checkout start failure -----------------------
  const failingHost = makeHost({
    billingClient: {
      // eslint-disable-next-line @typescript-eslint/require-await -- rejects
      createPricingCheckout: vi.fn(async () => {
        throw "boom";
      }),
    } as unknown as BillingUiHost["billingClient"],
  });
  const failing = await renderNode(
    <BillingUiProvider value={failingHost}>
      <BillingCheckoutClient
        billingInterval="monthly"
        intent="abc"
        plan="pro"
        seatCount={null}
        source="landing"
        teamName={null}
      />
    </BillingUiProvider>,
  );
  try {
    expect(failing.page).toContain(controls.checkoutError);
    expect(failing.page).not.toContain("Unable to start checkout.");
  } finally {
    await failing.unmount();
  }

  // ---- Billing success client ------------------------------------------------
  const readyHost = makeHost({
    billingClient: {
      getOrder: vi.fn(async () => ({
        id: "order-1",
        status: "fulfilled",
        amountTotal: 2000,
        billingInterval: "monthly",
        currency: "USD",
        planFamily: "individual_pro",
      })),
    } as unknown as BillingUiHost["billingClient"],
  });
  const ready = await renderNode(
    <BillingUiProvider value={readyHost}>
      <BillingSuccessClient orderId="order-1" />
    </BillingUiProvider>,
  );
  try {
    expect(ready.page).toContain(copy.checkout.success.ready);
    expect(ready.page).toContain(copy.checkout.success.readyDescription);
    expect(ready.page).toContain(copy.checkout.success.openDashboard);
    expect(ready.page).not.toContain("Ready");
    expect(ready.page).not.toContain(
      "Your billing update is ready in the dashboard.",
    );
    expect(ready.page).not.toContain("Open dashboard");
  } finally {
    await ready.unmount();
  }

  const syncingHost = makeHost({
    billingClient: {
      getOrder: vi.fn(),
    } as unknown as BillingUiHost["billingClient"],
  });
  const syncing = await renderNode(
    <BillingUiProvider value={syncingHost}>
      <BillingSuccessClient orderId={null} />
    </BillingUiProvider>,
  );
  try {
    expect(syncing.page).toContain(copy.checkout.success.syncing);
    expect(syncing.page).toContain(copy.checkout.success.pendingDescription);
    expect(syncing.page).not.toContain("Still syncing");
    expect(syncing.page).not.toContain(
      "We are checking the provider confirmation and applying your billing state.",
    );
  } finally {
    await syncing.unmount();
  }

  // ---- Sidebar usage summary ---------------------------------------------
  const sidebarHost = makeHost({
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
      getSummary: vi.fn(async () => ({
        teamId: "team-1",
        planFamily: "team_standard",
        billingMode: "enforced",
        cycleAnchorAt: "2026-09-01T00:00:00.000Z",
        cycleSource: "provider_subscription",
        cycleStartAt: "2026-09-01T00:00:00.000Z",
        cycleEndAt: "2026-10-05T00:00:00.000Z",
        pages: {
          limit: 1000,
          used: 200,
          remaining: 800,
          monthlyGrant: 900,
          monthlyBalance: 700,
          addOnBalance: 100,
          consumedThisCycle: 200,
          available: 12345,
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
      })),
    } as unknown as BillingUiHost["billingClient"],
  });
  const sidebar = await renderNode(
    <BillingUiProvider value={sidebarHost}>
      <SidebarUsageSummary />
    </BillingUiProvider>,
  );
  try {
    expect(sidebar.page).toContain(copy.sidebar.usageLabel);
    expect(sidebar.page).toContain(copy.common.credits);
    expect(sidebar.page).toContain(copy.sidebar.pagesLeft);
    expect(sidebar.page).toContain(copy.sidebar.cycleEnds);
    const button = sidebar.container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe(
      copy.sidebar.openUsageAriaLabel,
    );

    // Compact-notation credits (1000/5000) and the short cycle-end date go
    // through the billing locale's formatter (spec O2), independently
    // recomputed here so a regression to an ambient/`undefined`-locale
    // `Intl.*` call fails this instead of passing by coincidence.
    expect(sidebar.page).toContain(
      `${zhCNFormat.compactNumber(1000)} / ${zhCNFormat.compactNumber(5000)}`,
    );
    expect(sidebar.page).toContain(zhCNFormat.compactNumber(12345));
    expect(sidebar.page).toContain(
      zhCNFormat.shortDate("2026-10-05T00:00:00.000Z"),
    );

    expect(sidebar.page).not.toContain("Usage");
    expect(sidebar.page).not.toContain("Credits");
    expect(sidebar.page).not.toContain("Pages left");
    expect(sidebar.page).not.toContain("Cycle ends");
  } finally {
    await sidebar.unmount();
  }

  // Error state: `sidebar.unavailable` instead of the cycle-end date.
  const sidebarErrorHost = makeHost({
    authClient: sidebarHost.authClient,
    billingClient: {
      getSummary: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as BillingUiHost["billingClient"],
  });
  const sidebarError = await renderNode(
    <BillingUiProvider value={sidebarErrorHost}>
      <SidebarUsageSummary />
    </BillingUiProvider>,
  );
  try {
    expect(sidebarError.page).toContain(copy.sidebar.unavailable);
    expect(sidebarError.page).not.toContain("Unavailable");
  } finally {
    await sidebarError.unmount();
  }
});

// ---- Top-up actions ---------------------------------------------------------

test("top-up actions render in zh-CN and open the shared checkout dialog", async () => {
  const copy = getBillingCopy("zh-CN");

  let resolveTopup: (value: {
    provider: string;
    checkoutUrl: string;
    grantedPages?: number;
  }) => void = () => {};
  const pendingTopup = new Promise<{
    provider: string;
    checkoutUrl: string;
    grantedPages?: number;
  }>((resolve) => {
    resolveTopup = resolve;
  });
  const host = makeHost({
    billingTopupEnabled: true,
    billingClient: {
      createTopupCheckout: vi.fn(() => pendingTopup),
    } as unknown as BillingUiHost["billingClient"],
  });

  const rendered = await renderNode(
    <BillingUiProvider value={host}>
      <TopupActions teamId="team-1" />
    </BillingUiProvider>,
  );
  try {
    expect(rendered.page).toContain(copy.checkout.topup.title);
    expect(rendered.page).toContain(copy.checkout.topup.description);
    expect(rendered.page).toContain(copy.checkout.topup.buyCredits);
    expect(rendered.page).toContain(copy.checkout.topup.buyPages);
    expect(rendered.page).not.toContain("Add credits or pages");
    expect(rendered.page).not.toContain("Buy credits");
    expect(rendered.page).not.toContain("Buy pages");

    const buyPagesButton = Array.from(
      rendered.container.querySelectorAll("button"),
    ).find((button) => button.textContent === copy.checkout.topup.buyPages);
    expect(buyPagesButton).not.toBeUndefined();
    await act(async () => {
      buyPagesButton?.click();
    });
    await act(async () => {
      resolveTopup({
        provider: "waffo",
        checkoutUrl: "https://pay.waffo.test/session",
        grantedPages: 500,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.page).toContain(
      formatCopyLike(copy.checkout.waffoPagesDescription, {
        count: zhCNFormat.number(500),
      }),
    );
  } finally {
    await rendered.unmount();
  }
});

test("top-up actions show a localized error when starting checkout fails", async () => {
  const copy = getBillingCopy("zh-CN");
  const host = makeHost({
    billingTopupEnabled: true,
    billingClient: {
      // eslint-disable-next-line @typescript-eslint/require-await -- rejects
      createTopupCheckout: vi.fn(async () => {
        throw "boom";
      }),
    } as unknown as BillingUiHost["billingClient"],
  });

  const rendered = await renderNode(
    <BillingUiProvider value={host}>
      <TopupActions teamId="team-1" />
    </BillingUiProvider>,
  );
  try {
    const buyCreditsButton = Array.from(
      rendered.container.querySelectorAll("button"),
    ).find((button) => button.textContent === copy.checkout.topup.buyCredits);
    await act(async () => {
      buyCreditsButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.page).toContain(copy.checkout.topup.error);
  } finally {
    await rendered.unmount();
  }
});

// ---- Completeness: no un-localized English left in enterprise/billing/src/ui ----

const uiDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "ui",
);

function listTrackedUiSourceFiles(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "src/ui/*.tsx", "src/ui/*.ts"],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8",
    },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((relative) =>
      join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), relative),
    );
}

/**
 * Files/exact-line allow-list for the "no un-localized capitalized English"
 * scan below. Every entry is a line this scan would otherwise flag, kept
 * deliberately narrow (matched by file basename + the exact trimmed source
 * line) so a *new* violation elsewhere can never hide behind it.
 */
const CAPITALIZED_ENGLISH_ALLOWLIST: Array<{
  file: string;
  line: string;
  reason: string;
}> = [
  {
    file: "billing-utils.ts",
    line: 'return label || "Usage";',
    reason:
      "formatFeatureName's fallback for an empty beautified feature name — a raw-enum beautifier, same out-of-scope category F2/F3 established for feature names like cycleSource ('Provider Subscription'); not a catalogue-backed UI string.",
  },
  {
    file: "context.tsx",
    line: 'if (!value) throw new Error("Billing UI requires an explicit host provider");',
    reason:
      "a developer-facing integration error (thrown when a host app forgets to render BillingUiProvider) — never rendered to an end user, so it is not part of the localized UI copy.",
  },
  {
    file: "use-billing-copy.ts",
    line: 'currency: (cents, currency = "USD") =>',
    reason:
      "the ISO 4217 currency code default for BillingCopyFormat.currency — a technical value (D10: currency does not follow locale), not translatable text.",
  },
];

function isAllowlisted(file: string, line: string): boolean {
  return CAPITALIZED_ENGLISH_ALLOWLIST.some(
    (entry) => file.endsWith(entry.file) && line === entry.line,
  );
}

test("no un-localized capitalized English text remains in enterprise/billing/src/ui/*.{ts,tsx}", () => {
  const files = listTrackedUiSourceFiles();
  expect(files.length).toBeGreaterThan(0);

  // Same-line JSX text: `>Some text<`.
  const jsxTextRe = /(>[A-Z][a-zA-Z][^<{]*<)/g;
  // A quoted/template string starting with a capital letter: "Word...",
  // 'Word...', `Word...`.
  const quotedRe = /(["'`])([A-Z][a-zA-Z]+[^"'`]*)\1/g;
  // A standalone source line that reads as English prose (used for JSX text
  // nodes prettier wraps onto their own line). Import/destructuring/object
  // lines in this codebase always end with `,` or `;` (trailing commas are
  // the house style — confirmed via every multi-line import in this
  // directory), and identifiers never contain a space, so excluding
  // comma/semicolon-terminated and underscore-containing lines leaves only
  // real prose.
  const standaloneRe = /^[A-Z][a-zA-Z][a-zA-Z0-9 .,!?'"()-]*$/;

  const violations: string[] = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inBlockComment = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) {
        continue;
      }

      const hits: string[] = [];
      for (const match of trimmed.matchAll(jsxTextRe)) hits.push(match[1]);
      for (const match of trimmed.matchAll(quotedRe)) hits.push(match[0]);
      if (
        standaloneRe.test(trimmed) &&
        !trimmed.endsWith(",") &&
        !trimmed.endsWith(";") &&
        !trimmed.endsWith("(") &&
        !trimmed.includes("_")
      ) {
        hits.push(trimmed);
      }

      if (hits.length > 0 && !isAllowlisted(file, trimmed)) {
        violations.push(`${file.replace(`${uiDir}/`, "")}: ${trimmed}`);
      }
    }
  }

  expect(violations).toEqual([]);
});

// ---- Completeness: locale-explicit formatting (spec O2) -------------------

test("enterprise/billing/src/ui/** never constructs Intl.* or calls toLocaleString() outside use-billing-copy.ts", () => {
  const files = listTrackedUiSourceFiles().filter(
    (file) => !file.endsWith("use-billing-copy.ts"),
  );
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inBlockComment = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) {
        continue;
      }

      if (trimmed.includes("Intl.") || trimmed.includes("toLocaleString(")) {
        violations.push(`${file.replace(`${uiDir}/`, "")}: ${trimmed}`);
      }
    }
  }

  expect(violations).toEqual([]);
});
