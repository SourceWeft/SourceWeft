"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";
import { setAnalyticsCatalog } from "../analytics/events";
import { usePurchasesAllowed } from "../native-host";
import { deploymentClient } from "../sdk";
import { withoutPurchases } from "./purchase-policy";

type State =
  | { status: "loading"; capabilities: null; error: null }
  | { status: "ready"; capabilities: DeploymentCapabilities; error: null }
  | { status: "error"; capabilities: null; error: string };
const initial: State = { status: "loading", capabilities: null, error: null };
const Context = createContext<State>(initial);

export function DeploymentCapabilitiesProvider({
  children,
  initialCapabilities = null,
}: {
  children: ReactNode;
  initialCapabilities?: DeploymentCapabilities | null;
}) {
  const [state, setState] = useState<State>(
    initialCapabilities
      ? { status: "ready", capabilities: initialCapabilities, error: null }
      : initial,
  );
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    // Seeded from the server render; refetching would only re-run the same call.
    if (initialCapabilities && attempt === 0) {
      return;
    }
    let active = true;
    setState(initial);
    void deploymentClient.getCapabilities().then(
      (capabilities) => {
        if (active) setState({ status: "ready", capabilities, error: null });
      },
      (error: unknown) => {
        if (active)
          setState({
            status: "error",
            capabilities: null,
            error:
              error instanceof Error
                ? error.message
                : "Unable to load deployment capabilities",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, initialCapabilities]);
  useEffect(() => {
    setAnalyticsCatalog(
      state.status === "ready" && state.capabilities.edition === "commercial"
        ? state.capabilities.billing.catalog
        : null,
    );
  }, [state]);
  return (
    <Context.Provider value={state}>
      {state.status === "error" ? (
        <div
          role="alert"
          className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          Unable to load available features.{" "}
          <button type="button" className="underline" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
      {children}
    </Context.Provider>
  );
}

/**
 * What this deployment offers, as far as the host this page is shown in
 * allows. In a host where nothing may be sold (the iOS app) checkout and
 * top-ups are reported as unavailable, so every surface that reads this hides
 * its purchase controls without knowing about hosts.
 */
export function useDeploymentCapabilities() {
  const state = useContext(Context);
  const purchasesAllowed = usePurchasesAllowed();
  return useMemo(
    () => (purchasesAllowed ? state : withoutPurchases(state)),
    [state, purchasesAllowed],
  );
}
export function useBillingAvailable() {
  const state = useDeploymentCapabilities();
  return state.status === "ready" && state.capabilities.billing.available;
}

export function useCheckoutAvailable() {
  const state = useDeploymentCapabilities();
  return state.status === "ready" && state.capabilities.billing.checkout;
}

/**
 * Whether a team can be created here. Where teams are paid subscriptions,
 * creating one is a purchase, so it needs a host that allows purchases. Where
 * teams are free, it is always possible.
 */
export function useTeamCreationAvailable() {
  const state = useDeploymentCapabilities();
  const purchasesAllowed = usePurchasesAllowed();
  return (
    state.status === "ready" &&
    (purchasesAllowed || !state.capabilities.billing.teamSubscriptions)
  );
}
