"use client";

import * as React from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { billingClient } from "../../../../lib/sdk";

type BillingInterval = "monthly" | "yearly";
type PricingPlan = "pro" | "team";
type CheckoutSource = "landing" | "dashboard";
type CheckoutState = "preparing" | "opening" | "error";

function isPricingPlan(value: string | null): value is PricingPlan {
  return value === "pro" || value === "team";
}

function isBillingInterval(value: string | null): value is BillingInterval {
  return value === "monthly" || value === "yearly";
}

function normalizeSource(value: string | null): CheckoutSource {
  return value === "landing" ? "landing" : "dashboard";
}

function randomIntent() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeIntent(value: string | null) {
  return value?.trim().replace(/[^a-zA-Z0-9:_.-]/g, "").slice(0, 80) || "";
}

function getOrCreateIntent(input: {
  billingInterval: BillingInterval;
  intent: string | null;
  plan: PricingPlan;
  source: CheckoutSource;
  teamName: string;
}) {
  const provided = safeIntent(input.intent);
  if (provided) {
    return provided;
  }

  const storageKey = [
    "sourceweft:billing-checkout:intent",
    input.plan,
    input.billingInterval,
    input.source,
    input.teamName,
  ].join(":");
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }

  const next = randomIntent();
  window.sessionStorage.setItem(storageKey, next);
  return next;
}

function labelForPlan(plan: PricingPlan | null) {
  return plan === "team" ? "Team" : "Pro";
}

export function BillingCheckoutClient({
  billingInterval,
  intent,
  plan,
  source,
  teamName,
}: {
  billingInterval: string | null;
  intent: string | null;
  plan: string | null;
  source: string | null;
  teamName: string | null;
}) {
  const [state, setState] = React.useState<CheckoutState>("preparing");
  const [error, setError] = React.useState<string | null>(null);
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (startedRef.current) {
      return;
    }

    if (!isPricingPlan(plan) || !isBillingInterval(billingInterval)) {
      setError("This checkout link is no longer valid.");
      setState("error");
      return;
    }

    const checkoutPlan = plan;
    const checkoutBillingInterval = billingInterval;
    startedRef.current = true;
    const normalizedSource = normalizeSource(source);
    const normalizedTeamName = teamName?.trim() ?? "";
    const checkoutIntent = getOrCreateIntent({
      billingInterval: checkoutBillingInterval,
      intent,
      plan: checkoutPlan,
      source: normalizedSource,
      teamName: normalizedTeamName,
    });

    async function startCheckout() {
      try {
        const result = await billingClient.createPricingCheckout({
          plan: checkoutPlan,
          billingInterval: checkoutBillingInterval,
          source: normalizedSource,
          clientReferenceKey: `pricing:${checkoutPlan}:${checkoutBillingInterval}:${checkoutIntent}`,
          ...(checkoutPlan === "team" && normalizedTeamName
            ? { teamName: normalizedTeamName }
            : {}),
        });
        setState("opening");
        window.location.assign(result.checkoutUrl);
      } catch (checkoutError) {
        setError(
          checkoutError instanceof Error
            ? checkoutError.message
            : "Unable to start checkout.",
        );
        setState("error");
        startedRef.current = false;
      }
    }

    void startCheckout();
  }, [billingInterval, intent, plan, source, teamName]);

  const resolvedPlan = isPricingPlan(plan) ? plan : null;
  const title =
    state === "error" ? "Checkout needs attention" : "Opening checkout";
  const description =
    state === "error"
      ? error
      : state === "opening"
        ? "Your provider checkout is opening now."
        : `Preparing your ${labelForPlan(resolvedPlan)} checkout.`;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card px-6 py-7 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-background">
          {state === "error" ? (
            <AlertCircle className="h-5 w-5 text-destructive" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </div>
        <h1 className="mt-5 text-xl font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
        {state === "error" ? (
          <div className="mt-6 flex justify-center gap-2">
            <Button
              onClick={() => window.location.reload()}
              size="sm"
              type="button"
            >
              Try again
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href="/#pricing">Back to pricing</a>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
