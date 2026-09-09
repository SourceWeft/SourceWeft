"use client";
// Generated commercial billing bindings; subject to enterprise/LICENSE.
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import * as UI from "@sourceweft/billing/ui";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";
import { authClient } from "../auth-client";
import { billingCheckoutEnabled as deploymentCheckoutEnabled } from "../deployment-config";
import { billingClient, deploymentClient } from "../sdk";
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
  const [capabilities, setCapabilities] =
    useState<DeploymentCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    deploymentClient
      .getCapabilities()
      .then((value) => {
        if (active) setCapabilities(value);
      })
      .catch((error) => {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : "Unable to load billing capabilities",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!capabilities) return <p role="status">Loading billing…</p>;
  if (capabilities.edition !== "commercial")
    return <p role="alert">Web and API deployment editions do not match.</p>;
  return (
    <UI.BillingUiProvider
      value={{
        ...host,
        billingCheckoutEnabled:
          capabilities.billing.checkout && deploymentCheckoutEnabled,
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
