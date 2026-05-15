"use client";

import * as React from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { billingClient } from "../../../lib/sdk";

type SyncState = "finalizing" | "setting_up" | "ready" | "syncing";

function resolveState(status?: string): SyncState {
  if (status === "fulfilled") {
    return "ready";
  }

  if (status === "payment_confirmed") {
    return "setting_up";
  }

  if (status === "fulfillment_failed") {
    return "syncing";
  }

  return "finalizing";
}

const labels: Record<SyncState, string> = {
  finalizing: "Finalizing payment",
  setting_up: "Setting up your plan",
  ready: "Ready",
  syncing: "Still syncing",
};

export function BillingSuccessClient({ orderId }: { orderId?: string | null }) {
  const [state, setState] = React.useState<SyncState>("finalizing");

  React.useEffect(() => {
    if (!orderId) {
      setState("syncing");
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const resolvedOrderId = orderId;
    async function poll() {
      attempts += 1;
      try {
        const order = await billingClient.getOrder(resolvedOrderId);
        if (cancelled) {
          return;
        }

        const nextState = resolveState(order.status);
        setState(nextState);
        if (nextState === "ready" || attempts >= 8) {
          if (nextState !== "ready") {
            setState("syncing");
          }
          return;
        }
      } catch {
        if (!cancelled) {
          setState("syncing");
        }
        return;
      }

      window.setTimeout(poll, 1800);
    }

    void poll();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-card">
        {state === "ready" ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        )}
      </div>
      <h1 className="mt-5 text-xl font-semibold text-foreground">
        {labels[state]}
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {state === "ready"
          ? "Your billing update is ready in the dashboard."
          : "We are checking the provider confirmation and applying your billing state."}
      </p>
      <Button asChild className="mt-6" size="sm">
        <a href="/dashboard">Open dashboard</a>
      </Button>
    </div>
  );
}
