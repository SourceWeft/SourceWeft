"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";
import { deploymentClient } from "../sdk";

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

export function useDeploymentCapabilities() {
  return useContext(Context);
}
export function useBillingAvailable() {
  const state = useDeploymentCapabilities();
  return state.status === "ready" && state.capabilities.billing.available;
}

export function useCheckoutAvailable() {
  const state = useDeploymentCapabilities();
  return state.status === "ready" && state.capabilities.billing.checkout;
}
