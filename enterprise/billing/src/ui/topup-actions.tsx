"use client";
import { useState } from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useBillingUiHost } from "./context";

export function TopupActions({ teamId }: { teamId: string | null }) {
  const {
    billingClient,
    billingTopupEnabled,
    billingCheckoutEnabled,
    openCheckout,
  } = useBillingUiHost();
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
        error instanceof Error ? error.message : "Unable to prepare checkout",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 py-7">
      <p className="text-base font-semibold">Add credits or pages</p>
      <p className="text-sm text-muted-foreground">
        Choose a pack and review its total before paying.
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void buy("credit");
          }}
        >
          Buy credits
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void buy("page");
          }}
        >
          Buy pages
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
