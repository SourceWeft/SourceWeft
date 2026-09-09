"use client";
import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";
import type { BillingClient } from "@sourceweft/sdk";
type Interval = "monthly" | "yearly";
type Source = "landing" | "dashboard" | "settings";
export type BillingUiHost = {
  authClient: {
    useActiveOrganization(): { data: unknown };
    useListOrganizations(): { data: unknown };
    getSession(): Promise<{
      data?: { session?: unknown; user?: unknown } | null;
    }>;
  };
  billingClient: BillingClient;
  billingCheckoutEnabled: boolean;
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
const Context = createContext<BillingUiHost | null>(null);
export function BillingUiProvider({
  value,
  children,
}: {
  value: BillingUiHost;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useBillingUiHost(): BillingUiHost {
  const value = useContext(Context);
  if (!value) throw new Error("Billing UI requires an explicit host provider");
  return value;
}
