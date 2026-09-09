import { BillingError } from "./errors";
import type {
  BillingSubscriptionState,
  TeamSubscriptionSnapshot,
} from "./types";

export const terminalSubscription = (status: string) =>
  ["canceled", "expired"].includes(status);

export function assertSubscriptionPurchaseAllowed(
  current: BillingSubscriptionState | null,
) {
  if (
    current?.provider === "manual" &&
    current.confirmedPeriodEnd &&
    Date.parse(current.confirmedPeriodEnd) <= Date.now()
  )
    return;
  if (
    current &&
    !terminalSubscription(current.status) &&
    current.status !== "inactive"
  )
    throw new BillingError(
      "SUBSCRIPTION_ALREADY_ACTIVE",
      409,
      "A subscription is already active or awaiting resolution for this organization; manage it before purchasing another",
    );
}

export function subscriptionIdentity(
  snapshot: Pick<
    TeamSubscriptionSnapshot,
    | "provider"
    | "metadata"
    | "externalSubscriptionId"
    | "billingOrderId"
    | "teamId"
  >,
) {
  const metadata = snapshot.metadata;
  const scope =
    snapshot.provider === "waffo"
      ? metadata.waffoMerchantId
      : snapshot.provider === "stripe"
        ? metadata.stripeAccountId
        : metadata.providerScope;
  const environment =
    snapshot.provider === "waffo"
      ? metadata.waffoEnvironment
      : snapshot.provider === "stripe"
        ? metadata.stripeTestMode === true
          ? "test"
          : metadata.stripeTestMode === false
            ? "prod"
            : undefined
        : metadata.paymentEnvironment;
  // Manual and Creem bindings have no separate merchant field; never hash credentials.
  return `[${[
    snapshot.provider,
    scope ?? null,
    environment ?? null,
    snapshot.externalSubscriptionId ??
      snapshot.billingOrderId ??
      snapshot.teamId,
  ]
    .map((value) => JSON.stringify(value))
    .join(", ")}]`;
}

export function normalizeSubscriptionFact(
  current: BillingSubscriptionState | null,
  input: TeamSubscriptionSnapshot,
  establish: boolean,
): TeamSubscriptionSnapshot | null {
  if (
    input.provider === "manual" &&
    input.confirmCoverage &&
    (typeof input.metadata.authorizedBy !== "string" ||
      !input.metadata.authorizedBy ||
      typeof input.metadata.reason !== "string" ||
      !input.metadata.reason)
  )
    throw new BillingError(
      "MANUAL_SUBSCRIPTION_AUTHORIZATION_REQUIRED",
      403,
      "Manual coverage requires an authorized operator and reason",
    );
  if (current) {
    const same = subscriptionIdentity(current) === subscriptionIdentity(input);
    if (!same) {
      if (!establish) return null;
      assertSubscriptionPurchaseAllowed(current);
    } else if (
      terminalSubscription(current.status) &&
      !terminalSubscription(input.status)
    ) {
      return null;
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== (current.version ?? 0)
    )
      throw new BillingError(
        "SUBSCRIPTION_VERSION_CONFLICT",
        409,
        "Subscription changed while the provider was queried; retry with current state",
      );
  }
  const confirms =
    input.confirmCoverage === true || (establish && input.status === "active");
  if (confirms) {
    const start = Date.parse(input.currentPeriodStart ?? "");
    const end = Date.parse(input.currentPeriodEnd ?? "");
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      start > Date.now() ||
      end <= Date.now()
    )
      throw new BillingError(
        "INVALID_PROVIDER_SUBSCRIPTION_PERIOD",
        422,
        "Coverage confirmation requires a valid unexpired period",
      );
    if (
      current &&
      subscriptionIdentity(current) === subscriptionIdentity(input) &&
      current.confirmedPeriodStart &&
      (start < Date.parse(current.confirmedPeriodStart) ||
        (!!current.confirmedPeriodEnd &&
          end < Date.parse(current.confirmedPeriodEnd)))
    )
      return null;
  }
  const same =
    current && subscriptionIdentity(current) === subscriptionIdentity(input);
  const eventAt = Date.parse(input.eventOccurredAt ?? "");
  const previousAt = Date.parse(
    String(current?.metadata.subscriptionStateAt ?? ""),
  );
  const staleState =
    same &&
    Number.isFinite(eventAt) &&
    Number.isFinite(previousAt) &&
    eventAt < previousAt;
  if (staleState && !confirms) return null;
  return {
    ...input,
    ...(staleState
      ? { status: current.status, cancelAtPeriodEnd: current.cancelAtPeriodEnd }
      : {}),
    confirmCoverage: confirms,
    metadata: {
      ...(same ? current.metadata : {}),
      ...input.metadata,
      seatCount: input.seatCount,
      ...(Number.isFinite(eventAt) && !staleState
        ? { subscriptionStateAt: input.eventOccurredAt }
        : {}),
    },
    currentBindingId: same ? current.currentBindingId : undefined,
    version: (current?.version ?? 0) + 1,
    confirmedPeriodStart: confirms
      ? input.currentPeriodStart
      : same
        ? (current.confirmedPeriodStart ?? null)
        : null,
    confirmedPeriodEnd: confirms
      ? input.currentPeriodEnd
      : same
        ? (current.confirmedPeriodEnd ?? null)
        : null,
    currentPeriodStart:
      input.currentPeriodStart ?? (same ? current.currentPeriodStart : null),
    currentPeriodEnd:
      input.currentPeriodEnd ?? (same ? current.currentPeriodEnd : null),
  };
}
