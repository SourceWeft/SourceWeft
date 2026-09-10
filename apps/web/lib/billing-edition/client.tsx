"use client";
import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";
import { useDeploymentCapabilities } from "./capabilities";
import { TeamCheckoutDialog as CoreTeamDialog } from "./core-client";

type Commercial = typeof import("./commercial-client");
const Billing = lazy(() =>
  import("./commercial-client").then((m) => ({ default: m.BillingPanel })),
);
const Usage = lazy(() =>
  import("./commercial-client").then((m) => ({ default: m.UsagePanel })),
);
const Success = lazy(() =>
  import("./commercial-client").then((m) => ({
    default: m.BillingSuccessClient,
  })),
);
const Checkout = lazy(() =>
  import("./commercial-client").then((m) => ({
    default: m.BillingCheckoutClient,
  })),
);
const Pricing = lazy(() =>
  import("./commercial-client").then((m) => ({ default: m.PricingToggle })),
);
const Summary = lazy(() =>
  import("./commercial-client").then((m) => ({
    default: m.SidebarUsageSummary,
  })),
);
const Team = lazy(() =>
  import("./commercial-client").then((m) => ({
    default: m.TeamCheckoutDialog,
  })),
);

function Gate({ children }: { children: ReactNode }) {
  const state = useDeploymentCapabilities();
  if (state.status === "error") return <p role="alert">{state.error}</p>;
  if (state.status === "loading")
    return <p role="status">Loading available features…</p>;
  if (!state.capabilities.billing.available)
    return <p>Commercial features are disabled.</p>;
  return (
    <Suspense fallback={<p role="status">Loading billing…</p>}>
      {children}
    </Suspense>
  );
}
export function BillingPanel() {
  return (
    <Gate>
      <Billing />
    </Gate>
  );
}
export function UsagePanel() {
  return (
    <Gate>
      <Usage />
    </Gate>
  );
}
export function BillingSuccessClient(
  props: ComponentProps<Commercial["BillingSuccessClient"]>,
) {
  return (
    <Gate>
      <Success {...props} />
    </Gate>
  );
}
export function BillingCheckoutClient(
  props: ComponentProps<Commercial["BillingCheckoutClient"]>,
) {
  return (
    <Gate>
      <Checkout {...props} />
    </Gate>
  );
}
export function PricingToggle(
  props: ComponentProps<Commercial["PricingToggle"]>,
) {
  const state = useDeploymentCapabilities();
  if (state.status !== "ready" || !state.capabilities.billing.checkout)
    return null;
  return (
    <Gate>
      <Pricing {...props} />
    </Gate>
  );
}
export function SidebarUsageSummary(
  props: ComponentProps<Commercial["SidebarUsageSummary"]>,
) {
  const state = useDeploymentCapabilities();
  if (state.status !== "ready" || !state.capabilities.billing.available)
    return null;
  return (
    <Gate>
      <Summary {...props} />
    </Gate>
  );
}
export function TeamCheckoutDialog(
  props: ComponentProps<Commercial["TeamCheckoutDialog"]>,
) {
  const state = useDeploymentCapabilities();
  // Never treat a capability request failure as permission to create a free team.
  if (state.status !== "ready") return props.open ? <Gate>{null}</Gate> : null;
  if (!state.capabilities.billing.teamSubscriptions)
    return <CoreTeamDialog {...props} />;
  return (
    <Gate>
      <Team {...props} />
    </Gate>
  );
}
