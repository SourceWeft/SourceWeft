"use client";
import { useState } from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useBillingUiHost } from "./context";
import { useBillingCopy } from "./use-billing-copy";

export function TopupActions({ teamId }: { teamId: string | null }) {
  const {
    billingClient,
    billingTopupEnabled,
    billingCheckoutEnabled,
    openCheckout,
  } = useBillingUiHost();
  const { copy } = useBillingCopy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!teamId || !billingTopupEnabled || !billingCheckoutEnabled) return null;
  async function buy(unitType: "credit" | "page") {
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await billingClient.createTopupCheckout(teamId, {
        unitType,
        quantity: 1,
        clientReferenceKey: `topup:${crypto.randomUUID()}`,
      });
      openCheckout(result);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : copy.checkout.topup.error,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 py-7">
      <p className="text-base font-semibold">{copy.checkout.topup.title}</p>
      <p className="text-sm text-muted-foreground">
        {copy.checkout.topup.description}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void buy("credit");
          }}
        >
          {copy.checkout.topup.buyCredits}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void buy("page");
          }}
        >
          {copy.checkout.topup.buyPages}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
