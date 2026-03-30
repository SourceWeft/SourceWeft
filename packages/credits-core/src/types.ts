export type PlanFamily =
  | "individual_free"
  | "individual_pro"
  | "team_standard"
  | "team_premium"
  | "enterprise_usage";

export type BillingMode = "disabled" | "shadow" | "enforced";

export type BillingScope = "individual_only" | "team_enabled";

export type BillingProvider = "none" | "creem" | "stripe" | "manual";

export type LedgerEventType =
  | "grant"
  | "reserve"
  | "consume"
  | "release"
  | "refund"
  | "expire"
  | "adjust";

export type LedgerUnitType = "credit" | "page";
