import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";

type CapabilitiesState =
  | { status: "loading"; capabilities: null; error: null }
  | { status: "ready"; capabilities: DeploymentCapabilities; error: null }
  | { status: "error"; capabilities: null; error: string };

/**
 * The same capabilities with nothing for sale: no checkout and no top-ups.
 *
 * `available` stays as it is, so usage and the current plan can still be
 * shown. `teamSubscriptions` stays too: turning it off would make team
 * creation fall through to the free flow of the core edition.
 */
export function withoutPurchases<T extends CapabilitiesState>(state: T): T {
  if (state.status !== "ready" || state.capabilities.edition !== "commercial") {
    return state;
  }
  const { billing } = state.capabilities;
  if (!billing.checkout && !billing.topup) {
    return state;
  }
  return {
    ...state,
    capabilities: {
      ...state.capabilities,
      billing: { ...billing, checkout: false, topup: false },
    },
  };
}
