"use client";
import {
  createContext,
  useState,
  useCallback,
  useContext,
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
import { getBillingControls } from "../messages";

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
            <DialogTitle>Secure payment</DialogTitle>
            <DialogDescription>
              {checkoutUrl?.grantedCredits
                ? `${checkoutUrl.grantedCredits.toLocaleString()} credits. `
                : checkoutUrl?.grantedPages
                  ? `${checkoutUrl.grantedPages.toLocaleString()} pages. `
                  : ""}
              Open Waffo checkout in a new tab to review the total and pay. Your
              current page stays open.
            </DialogDescription>
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
            Open checkout
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

export function useBillingControls() {
  const { locale = "en" } = useBillingUiHost();
  return getBillingControls(locale);
}
