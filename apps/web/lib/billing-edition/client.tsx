"use client";
import { useState } from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { authClient } from "../auth-client";
import type { PlanConfig } from "@sourceweft/contracts/pricing";
export function BillingPanel() {
  return null;
}
export function UsagePanel() {
  return null;
}
export function BillingSuccessClient(_props: { orderId?: string | null }) {
  void _props;
  return <BillingPanel />;
}
export function BillingCheckoutClient(_props: {
  billingInterval: string | null;
  intent: string | null;
  plan: string | null;
  seatCount: string | null;
  source: string | null;
  teamName: string | null;
}) {
  void _props;
  return <BillingPanel />;
}
export function PricingToggle(_props: {
  plans: PlanConfig[];
  authState: {
    isPending: boolean;
    isSignedIn: boolean;
    user: { email?: string | null; name?: string | null } | null;
  };
}) {
  void _props;
  return null;
}
export function SidebarUsageSummary(props: { onOpenUsage?: () => void }) {
  void props;
  return null;
}
export function TeamCheckoutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  billingInterval: "monthly" | "yearly";
  perSeatPrice: number;
  source: "landing" | "dashboard" | "settings";
  allowBillingIntervalSwitch?: boolean;
  authRedirectOnUnauthenticated?: boolean;
  monthlyPerSeatPrice?: number;
  yearlyPerSeatPrice?: number;
  referencePrefix?: string;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create team</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const result = await authClient.organization.create({
                name: name.trim(),
                slug: `team-${crypto.randomUUID()}`,
                metadata: { sourceweft: { kind: "team" } },
              });
              if (result.error)
                throw new Error(
                  result.error.message || "Unable to create team",
                );
              if (result.data?.id)
                await authClient.organization.setActive({
                  organizationId: result.data.id,
                });
              onOpenChange(false);
              setName("");
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : "Unable to create team",
              );
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-4"
        >
          <label className="block text-sm">
            Team name
            <input
              aria-label="Team name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 block w-full rounded-md border p-2"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create team"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
