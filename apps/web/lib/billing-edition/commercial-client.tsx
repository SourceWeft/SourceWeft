"use client";
// Commercial UI adapter; subject to enterprise/LICENSE.
import { useLocale } from "next-intl";
import { type ComponentProps, type ReactNode } from "react";
import { useDeploymentCapabilities } from "./capabilities";
import * as UI from "@sourceweft/billing/ui";
import { authClient } from "../auth-client";
import { billingClient } from "../sdk";
import {
  trackBeginCheckout,
  trackCheckoutError,
  trackBillingPortalOpened,
  trackPurchase,
} from "../analytics-events";
import {
  BillingPanelSkeleton,
  UsagePanelSkeleton,
  SettingsSkeletonBlock,
} from "../../app/dashboard/_components/dashboard-settings-center-modal-skeleton";
import { OrgSwitcher } from "../../app/dashboard/_components/dashboard-settings-center/org-switcher";
import { subscribeDashboardBillingSummaryRefresh } from "../../app/dashboard/_components/dashboard-billing-summary-refresh";
const host = {
  authClient,
  billingClient,
  trackBeginCheckout,
  trackCheckoutError,
  trackBillingPortalOpened,
  trackPurchase,
  BillingPanelSkeleton,
  UsagePanelSkeleton,
  SettingsSkeletonBlock,
  OrgSwitcher,
  subscribeDashboardBillingSummaryRefresh,
};
function Provider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const state = useDeploymentCapabilities();
  if (state.status === "error") return <p role="alert">{state.error}</p>;
  if (state.status === "loading") return <p role="status">Loading billing…</p>;
  const capabilities = state.capabilities;
  if (!capabilities.billing.available)
    return <p>Commercial features are disabled.</p>;
  return (
    <UI.BillingUiProvider
      value={{
        ...host,
        locale,
        billingProvider: capabilities.billing.provider,
        billingTopupEnabled: capabilities.billing.topup,
        billingCheckoutEnabled: capabilities.billing.checkout,
      }}
    >
      {children}
    </UI.BillingUiProvider>
  );
}
export function BillingPanel() {
  return (
    <Provider>
      <UI.BillingPanel />
    </Provider>
  );
}
export function UsagePanel() {
  return (
    <Provider>
      <UI.UsagePanel />
    </Provider>
  );
}
export function BillingSuccessClient(
  props: ComponentProps<typeof UI.BillingSuccessClient>,
) {
  return (
    <Provider>
      <UI.BillingSuccessClient {...props} />
    </Provider>
  );
}
export function BillingCheckoutClient(
  props: ComponentProps<typeof UI.BillingCheckoutClient>,
) {
  return (
    <Provider>
      <UI.BillingCheckoutClient {...props} />
    </Provider>
  );
}
export function TeamCheckoutDialog(
  props: ComponentProps<typeof UI.TeamCheckoutDialog>,
) {
  return (
    <Provider>
      <UI.TeamCheckoutDialog {...props} />
    </Provider>
  );
}
export function PricingToggle(props: ComponentProps<typeof UI.PricingToggle>) {
  return (
    <Provider>
      <UI.PricingToggle {...props} />
    </Provider>
  );
}
export function SidebarUsageSummary(
  props: ComponentProps<typeof UI.SidebarUsageSummary>,
) {
  return (
    <Provider>
      <UI.SidebarUsageSummary {...props} />
    </Provider>
  );
}
