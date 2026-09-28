"use client";
import {
  createContext,
  useState,
  useCallback,
  useContext,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@sourceweft/ui-web/components/ui/dialog";
import type { BillingClient } from "@sourceweft/sdk";
import { formatNumber, isLocale, type Locale } from "@sourceweft/i18n";
import { formatCopy, getBillingControls, getBillingCopy } from "../messages";

type Interval = "monthly" | "yearly";
type Source = "landing" | "dashboard" | "settings";
export type BillingUiHost = {
  locale?: string;
  authClient: {
    useActiveOrganization(): { data: unknown };
    useListOrganizations(): { data: unknown };
    getSession(): Promise<{
      data?: { session?: unknown; user?: unknown } | null;
    }>;
  };
  billingClient: BillingClient;
  billingCheckoutEnabled: boolean;
  billingProvider?: string;
  billingTopupEnabled?: boolean;
  OrgSwitcher: ComponentType<{ className?: string }>;
  BillingPanelSkeleton: ComponentType;
  UsagePanelSkeleton: ComponentType;
  SettingsSkeletonBlock: ComponentType<{ className?: string }>;
  subscribeDashboardBillingSummaryRefresh(listener: () => void): () => void;
  trackBeginCheckout(input: {
    billingInterval: Interval;
    plan: "pro" | "team";
    seatCount?: number;
    source: Source;
  }): void;
  trackCheckoutError(input: {
    billingInterval: Interval;
    plan: "pro" | "team";
    source: Source;
  }): void;
  trackBillingPortalOpened(input: {
    scope: "personal" | "team";
    source: "dashboard" | "settings";
  }): void;
  trackPurchase(input: {
    amountTotal: number | null;
    billingInterval: string | null;
    currency: string | null;
    orderId: string;
    planFamily: string | null;
  }): void;
};
type CheckoutResult = {
  provider: string;
  checkoutUrl: string;
  grantedCredits?: number;
  grantedPages?: number;
  amountUsd?: number;
};
type CheckoutNavigation = { openCheckout(result: CheckoutResult): void };
const Context = createContext<(BillingUiHost & CheckoutNavigation) | null>(
  null,
);
export function BillingUiProvider({
  value,
  children,
}: {
  value: BillingUiHost;
  children: ReactNode;
}) {
  const [checkoutUrl, setCheckoutUrl] = useState<CheckoutResult | null>(null);
  const openCheckout = useCallback((result: CheckoutResult) => {
    if (result.provider === "waffo") setCheckoutUrl(result);
    else window.location.assign(result.checkoutUrl);
  }, []);

  // `BillingUiProvider` establishes the `Context.Provider` below, so it
  // cannot read its own value back through `useBillingCopy()`/`useContext`
  // (that would only see whatever *outer* provider is in scope, not this
  // one) — it builds the catalogue/number-formatting directly from the
  // `value.locale` prop it already has, the same way `useBillingControls()`
  // (via `getBillingControls`) already does in this file.
  const locale = value.locale ?? "en";
  const copy = getBillingCopy(locale);
  const intlLocale: Locale = isLocale(locale) ? locale : "en";
  const formatCount = (count: number) =>
    formatNumber(count, intlLocale, { maximumFractionDigits: 0 });

  const waffoDescription = checkoutUrl?.grantedCredits
    ? formatCopy(copy.checkout.waffoCreditsDescription, {
        count: formatCount(checkoutUrl.grantedCredits),
      })
    : checkoutUrl?.grantedPages
      ? formatCopy(copy.checkout.waffoPagesDescription, {
          count: formatCount(checkoutUrl.grantedPages),
        })
      : copy.checkout.waffoGenericDescription;

  return (
    <Context.Provider value={{ ...value, openCheckout }}>
      {children}
      <Dialog
        open={Boolean(checkoutUrl)}
        onOpenChange={(open) => {
          if (!open) setCheckoutUrl(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.checkout.securePaymentTitle}</DialogTitle>
            <DialogDescription>{waffoDescription}</DialogDescription>
          </DialogHeader>
          <Button
            onClick={() => {
              if (checkoutUrl)
                window.open(
                  checkoutUrl.checkoutUrl,
                  "_blank",
                  "noopener,noreferrer",
                );
            }}
          >
            {copy.checkout.openCheckout}
          </Button>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}
export function useBillingUiHost(): BillingUiHost & CheckoutNavigation {
  const value = useContext(Context);
  if (!value) throw new Error("Billing UI requires an explicit host provider");
  return value;
}

/** The billing UI's resolved locale, defaulting to English like every accessor in `../messages`. */
export function useBillingLocale(): string {
  const { locale = "en" } = useBillingUiHost();
  return locale;
}

/**
 * Memoized so the returned object is referentially stable across renders for
 * the same locale — callers that need `controls.*` inside a `useEffect`/
 * `useCallback` dependency array (e.g. `billing-checkout-client.tsx`'s
 * checkout-start effect) can depend on it without re-running every render,
 * the same way `useBillingCopy()`'s `copy` is already memoized.
 */
export function useBillingControls() {
  const locale = useBillingLocale();
  return useMemo(() => getBillingControls(locale), [locale]);
}
