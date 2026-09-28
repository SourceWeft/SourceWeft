"use client";
import { useBillingControls, useBillingUiHost } from "./context";
import { useBillingCopy } from "./use-billing-copy";
import { formatCopy } from "../messages";

import * as React from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { toast } from "sonner";

type BillingInterval = "monthly" | "yearly";
type CheckoutSource = "landing" | "dashboard";

const MIN_TEAM_SEATS = 2;
const MAX_TEAM_SEATS = 99;

function formatPrice(cents: number, freeLabel: string): string {
  if (cents === 0) return freeLabel;
  return `$${(cents / 100).toFixed(0)}`;
}

function createCheckoutIntent() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createReferenceKey(input: {
  billingInterval: BillingInterval;
  referencePrefix: string;
  seatCount: number;
  source: CheckoutSource;
}) {
  return [
    input.referencePrefix,
    "team",
    input.billingInterval,
    input.source,
    input.seatCount,
    createCheckoutIntent(),
  ].join(":");
}

function createPricingCheckoutPath(input: {
  billingInterval: BillingInterval;
  seatCount: number;
  source: CheckoutSource;
  teamName: string;
}) {
  const params = new URLSearchParams({
    billingInterval: input.billingInterval,
    intent: createCheckoutIntent(),
    plan: "team",
    seatCount: String(input.seatCount),
    source: input.source,
    teamName: input.teamName,
  });

  return `/dashboard/billing/checkout?${params.toString()}`;
}

function createPricingAuthHref(input: {
  billingInterval: BillingInterval;
  seatCount: number;
  source: CheckoutSource;
  teamName: string;
}) {
  return `/auth/sign-in?redirectTo=${encodeURIComponent(
    createPricingCheckoutPath(input),
  )}`;
}

function parseTeamSeatCount(value: string) {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_TEAM_SEATS ||
    parsed > MAX_TEAM_SEATS
  ) {
    return null;
  }

  return parsed;
}

function normalizeTeamSeatCountInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_TEAM_SEATS) {
    return String(MIN_TEAM_SEATS);
  }

  if (parsed > MAX_TEAM_SEATS) {
    return String(MAX_TEAM_SEATS);
  }

  return String(Math.floor(parsed));
}

export function TeamCheckoutDialog({
  allowBillingIntervalSwitch = false,
  authRedirectOnUnauthenticated = false,
  billingInterval,
  monthlyPerSeatPrice,
  onOpenChange,
  open,
  perSeatPrice,
  referencePrefix = "team-checkout",
  source,
  yearlyPerSeatPrice,
}: {
  allowBillingIntervalSwitch?: boolean;
  authRedirectOnUnauthenticated?: boolean;
  billingInterval: BillingInterval;
  monthlyPerSeatPrice?: number;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  perSeatPrice: number;
  referencePrefix?: string;
  source: CheckoutSource;
  yearlyPerSeatPrice?: number;
}) {
  const {
    trackBeginCheckout,
    trackCheckoutError,
    authClient,
    billingClient,
    openCheckout,
  } = useBillingUiHost();
  const { copy, format } = useBillingCopy();
  const controls = useBillingControls();
  const billingIntervalOptions = [
    {
      value: "yearly" as const,
      label: controls.yearly,
      badge: copy.checkout.saveTwoMonths,
    },
    { value: "monthly" as const, label: controls.monthly, badge: undefined },
  ];

  const [teamName, setTeamName] = React.useState("");
  const [seatCountInput, setSeatCountInput] = React.useState(
    String(MIN_TEAM_SEATS),
  );
  const [selectedBillingInterval, setSelectedBillingInterval] =
    React.useState<BillingInterval>(billingInterval);
  const [isLoading, setIsLoading] = React.useState(false);
  const nameInputId = React.useId();
  const seatsInputId = React.useId();
  const currentBillingInterval = allowBillingIntervalSwitch
    ? selectedBillingInterval
    : billingInterval;
  const currentPerSeatPrice =
    currentBillingInterval === "yearly"
      ? (yearlyPerSeatPrice ?? perSeatPrice)
      : (monthlyPerSeatPrice ?? perSeatPrice);
  const seatCount = parseTeamSeatCount(seatCountInput) ?? MIN_TEAM_SEATS;
  const totalPrice = currentPerSeatPrice * seatCount;

  React.useEffect(() => {
    if (open) {
      setSelectedBillingInterval(billingInterval);
    }
  }, [billingInterval, open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedTeamName = teamName.trim();
    if (!normalizedTeamName) {
      toast.error(copy.checkout.enterTeamName);
      return;
    }

    const requestedSeatCount = parseTeamSeatCount(seatCountInput);
    if (!requestedSeatCount) {
      toast.error(
        formatCopy(copy.checkout.seatsRange, {
          min: format.number(MIN_TEAM_SEATS),
          max: format.number(MAX_TEAM_SEATS),
        }),
      );
      return;
    }

    setIsLoading(true);
    try {
      const session = await authClient.getSession();
      const isLoggedIn = Boolean(session.data?.session || session.data?.user);

      if (!isLoggedIn && authRedirectOnUnauthenticated) {
        window.location.assign(
          createPricingAuthHref({
            billingInterval: currentBillingInterval,
            seatCount: requestedSeatCount,
            source,
            teamName: normalizedTeamName,
          }),
        );
        return;
      }

      const result = await billingClient.createPricingCheckout({
        billingInterval: currentBillingInterval,
        clientReferenceKey: createReferenceKey({
          billingInterval: currentBillingInterval,
          referencePrefix,
          seatCount: requestedSeatCount,
          source,
        }),
        plan: "team",
        seatCount: requestedSeatCount,
        source,
        teamName: normalizedTeamName,
      });
      trackBeginCheckout({
        billingInterval: currentBillingInterval,
        plan: "team",
        seatCount: requestedSeatCount,
        source,
      });
      openCheckout(result);
    } catch (error) {
      trackCheckoutError({
        billingInterval: currentBillingInterval,
        plan: "team",
        source,
      });
      toast.error(
        error instanceof Error ? error.message : controls.checkoutError,
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!isLoading) {
          onOpenChange(nextOpen);
        }
      }}
      open={open}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-[360px] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b px-4 py-3.5">
          <DialogTitle className="text-base">
            {copy.checkout.createTeam}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">
            {copy.checkout.createTeamDescription}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4 px-4 py-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={nameInputId}
            >
              {copy.checkout.teamNameLabel}
            </label>
            <input
              autoComplete="organization"
              autoFocus
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
              id={nameInputId}
              maxLength={80}
              onChange={(event) => setTeamName(event.currentTarget.value)}
              placeholder={copy.checkout.teamNamePlaceholder}
              required
              type="text"
              value={teamName}
            />
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={seatsInputId}
            >
              {copy.common.seats}
            </label>
            <input
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoading}
              id={seatsInputId}
              max={MAX_TEAM_SEATS}
              min={MIN_TEAM_SEATS}
              onBlur={(event) =>
                setSeatCountInput(
                  normalizeTeamSeatCountInput(event.currentTarget.value),
                )
              }
              onChange={(event) => setSeatCountInput(event.currentTarget.value)}
              required
              step={1}
              type="number"
              value={seatCountInput}
            />
          </div>

          {allowBillingIntervalSwitch ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">
                {copy.checkout.billingLabel}
              </p>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/40 p-1">
                {billingIntervalOptions.map((option) => {
                  const isActive = currentBillingInterval === option.value;

                  return (
                    <button
                      className={`flex h-9 items-center justify-center gap-1.5 rounded-[5px] px-2 text-sm font-medium transition-colors ${
                        isActive
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      disabled={isLoading}
                      key={option.value}
                      onClick={() => setSelectedBillingInterval(option.value)}
                      type="button"
                    >
                      <span>{option.label}</span>
                      {option.badge ? (
                        <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-emerald-700 dark:text-emerald-300">
                          {option.badge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">
                {copy.checkout.total}
              </span>
              <span className="font-semibold text-foreground">
                {formatPrice(totalPrice, controls.free)}
                <span className="font-normal text-muted-foreground">
                  /
                  {currentBillingInterval === "yearly"
                    ? controls.year
                    : controls.month}
                </span>
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatCopy(copy.checkout.perSeatSummary, {
                price: formatPrice(currentPerSeatPrice, controls.free),
                count: format.number(seatCount),
              })}
            </p>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t pt-3 sm:flex-row sm:justify-end">
            <Button
              disabled={isLoading}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {copy.common.cancel}
            </Button>
            <Button disabled={isLoading} type="submit">
              {isLoading ? controls.opening : copy.checkout.continue}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
