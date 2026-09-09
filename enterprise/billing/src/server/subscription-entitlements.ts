import type { BillingSubscriptionState } from "./types";

/** Entitlement coverage is local state; credentials and checkout selection are irrelevant. */
export function confirmedSubscriptionPeriod(
  subscription: BillingSubscriptionState | null,
) {
  if (
    !subscription ||
    !["active", "past_due", "trialing"].includes(subscription.status)
  )
    return null;
  const start = subscription.confirmedPeriodStart;
  const end = subscription.confirmedPeriodEnd;
  if (
    !start ||
    !end ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(end) <= Date.parse(start)
  )
    return null;
  return { start, end };
}

export function hasCurrentCoverage(
  subscription: BillingSubscriptionState | null,
  now = Date.now(),
) {
  const period = confirmedSubscriptionPeriod(subscription);
  return (
    !!period && Date.parse(period.start) <= now && now < Date.parse(period.end)
  );
}
