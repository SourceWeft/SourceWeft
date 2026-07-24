import type { billingClient } from "../../../../lib/sdk";

export type SettingsCenterTab =
  | "account"
  | "team"
  | "workspace"
  | "usage"
  | "billing"
  | "approvals";
export type BillingScope = "personal" | "team";
export type BillingInterval = "monthly" | "yearly";
export type BillingSummary = Awaited<
  ReturnType<typeof billingClient.getSummary>
>;
export type BillingSubscription = Awaited<
  ReturnType<typeof billingClient.getSubscription>
>;
export type BillingLedger = Awaited<
  ReturnType<typeof billingClient.getActivity>
>;
export type BillingLedgerEntry = BillingLedger["items"][number];
export type SeatPreview = Awaited<
  ReturnType<typeof billingClient.previewSubscriptionSeats>
>;
export type BillingOrg = {
  id: string;
  metadata?: unknown;
  name: string;
  slug?: string;
};
export type UsageActivityFilter = "all" | BillingLedgerEntry["unitType"];
export type UsageActivityRow = {
  key: string;
  detail: string;
  date: string;
  change: string;
  unitType: UsageActivityFilter;
};
export type UsageActivityKind = "image" | "vision" | "chat" | "video" | "other";
