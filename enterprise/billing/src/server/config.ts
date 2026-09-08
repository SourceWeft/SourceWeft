import { validateBillingCatalog } from "./catalog";
import type {
  BillingMode,
  BillingProvider,
  BillingScope,
  PlanFamily,
} from "@sourceweft/credits-core";
import type { BillingRuntimeConfig } from "./types";
import { parseBooleanEnv as parseBoolean } from "./env";

function parsePositiveNumber(value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Billing configuration value must be a positive number");
  }

  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      "Billing configuration value must be a non-negative number",
    );
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = parseNonNegativeNumber(value, fallback);
  if (!Number.isInteger(parsed))
    throw new Error("Billing configuration value must be an integer");
  return parsed;
}

const billingModes: ReadonlySet<BillingMode> = new Set([
  "disabled",
  "shadow",
  "enforced",
]);

const billingScopes: ReadonlySet<BillingScope> = new Set([
  "individual_only",
  "team_enabled",
]);

const billingProviders: ReadonlySet<BillingProvider> = new Set([
  "none",
  "creem",
  "stripe",
  "manual",
]);

const planFamilies: ReadonlySet<PlanFamily> = new Set([
  "individual_free",
  "individual_pro",
  "team_standard",
  "team_premium",
  "enterprise_usage",
]);

function parseBillingMode(value: string | undefined, fallback: BillingMode) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as BillingMode;
  if (!billingModes.has(normalized))
    throw new Error("Invalid BACKEND_BILLING_MODE");
  return normalized;
}

function parseBillingProvider(
  value: string | undefined,
  fallback: BillingProvider,
) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as BillingProvider;
  if (!billingProviders.has(normalized))
    throw new Error("Invalid BACKEND_BILLING_PROVIDER");
  return normalized;
}

function parseBillingScope(value: string | undefined, fallback: BillingScope) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as BillingScope;
  if (!billingScopes.has(normalized))
    throw new Error("Invalid BACKEND_BILLING_SCOPE");
  return normalized;
}

function parsePlanFamily(value: string | undefined, fallback: PlanFamily) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as PlanFamily;
  if (!planFamilies.has(normalized))
    throw new Error("Invalid BACKEND_DEFAULT_PLAN_FAMILY");
  return normalized;
}

export function readBillingConfig(
  env: Readonly<Record<string, string | undefined>>,
  webBaseUrl: string,
): BillingRuntimeConfig {
  const saasEnabled = parseBoolean(env.SOURCEWEFT_SAAS_ENABLED, false);
  const requestedBillingProvider = parseBillingProvider(
    env.BACKEND_BILLING_PROVIDER,
    "none",
  );
  if (saasEnabled && !["none", "creem"].includes(requestedBillingProvider)) {
    throw new Error(
      `BACKEND_BILLING_PROVIDER=${requestedBillingProvider} is not supported for checkout`,
    );
  }
  const effectiveBillingProvider =
    saasEnabled && requestedBillingProvider === "creem" ? "creem" : "none";
  return {
    saasEnabled,
    mode: parseBillingMode(env.BACKEND_BILLING_MODE, "enforced"),
    scope: parseBillingScope(env.BACKEND_BILLING_SCOPE, "individual_only"),
    creditsEnabled: parseBoolean(env.BACKEND_CREDITS_ENABLED, true),
    pagesEnabled: parseBoolean(env.BACKEND_PAGES_ENABLED, true),
    provider: effectiveBillingProvider,
    enforceLimits: parseBoolean(env.BACKEND_BILLING_ENFORCE_LIMITS, true),
    teamBillingEnabled:
      saasEnabled && parseBoolean(env.BACKEND_TEAM_BILLING_ENABLED, false),
    creditUnitUsd: parsePositiveNumber(env.BACKEND_CREDIT_UNIT_USD, 0.00125),
    defaultMarkupRate: parseNonNegativeNumber(
      env.BACKEND_CREDIT_MARKUP_RATE,
      0.25,
    ),
    defaultPlanFamily: parsePlanFamily(
      env.BACKEND_DEFAULT_PLAN_FAMILY,
      "individual_free",
    ),
    defaultMonthlyPages: parseNonNegativeInteger(
      env.BACKEND_DEFAULT_MONTHLY_PAGES,
      300,
    ),
    defaultMonthlyCredits: parseNonNegativeInteger(
      env.BACKEND_DEFAULT_MONTHLY_CREDITS,
      3000,
    ),
    reconcileEnabled:
      saasEnabled && parseBoolean(env.BACKEND_BILLING_RECONCILE_ENABLED, false),
    defaultSuccessUrl: `${webBaseUrl.replace(/\/$/, "")}/dashboard/billing?checkout=success`,
    creem: {
      apiKey: env.CREEM_API_KEY || "",
      webhookSecret: env.CREEM_WEBHOOK_SECRET || "",
      testMode: parseBoolean(env.CREEM_TEST_MODE, true),
      individualProMonthlyProductId:
        env.CREEM_INDIVIDUAL_PRO_MONTHLY_PRODUCT_ID || "",
      individualProYearlyProductId:
        env.CREEM_INDIVIDUAL_PRO_YEARLY_PRODUCT_ID || "",
      teamStandardMonthlyProductId:
        env.CREEM_TEAM_STANDARD_MONTHLY_PRODUCT_ID || "",
      teamStandardYearlyProductId:
        env.CREEM_TEAM_STANDARD_YEARLY_PRODUCT_ID || "",
      creditTopupProductId: env.CREEM_CREDIT_TOPUP_PRODUCT_ID || "",
      pageTopupProductId: env.CREEM_PAGE_TOPUP_PRODUCT_ID || "",
    },
    catalog: {
      individualProMonthlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_INDIVIDUAL_PRO_MONTHLY_CENTS,
        1200,
      ),
      individualProYearlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_INDIVIDUAL_PRO_YEARLY_CENTS,
        9600,
      ),
      teamStandardMonthlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_TEAM_STANDARD_MONTHLY_CENTS,
        4900,
      ),
      teamStandardYearlyAmountCents: parsePositiveNumber(
        env.BILLING_PRICE_TEAM_STANDARD_YEARLY_CENTS,
        39200,
      ),
      creditTopupUnitAmount: parsePositiveNumber(
        env.BILLING_CREDIT_TOPUP_UNIT_AMOUNT,
        10000,
      ),
      creditTopupAmountCents: parsePositiveNumber(
        env.BILLING_CREDIT_TOPUP_AMOUNT_CENTS,
        1250,
      ),
      pageTopupUnitAmount: parsePositiveNumber(
        env.BILLING_PAGE_TOPUP_UNIT_AMOUNT,
        1000,
      ),
      pageTopupAmountCents: parsePositiveNumber(
        env.BILLING_PAGE_TOPUP_AMOUNT_CENTS,
        500,
      ),
    },
  };
}

/** Validate only enabled payment products; credentials alone never enable checkout. */
export function validateBillingConfiguration(
  config: BillingRuntimeConfig,
): void {
  if (config.saasEnabled && config.provider === "creem") {
    for (const [name, value] of [
      ["CREEM_API_KEY", config.creem.apiKey],
      ["CREEM_WEBHOOK_SECRET", config.creem.webhookSecret],
    ]) {
      if (!value?.trim())
        throw new Error(`${name} is required for enabled checkout`);
    }
    validateBillingCatalog({
      runtimeConfig: config,
      subscriptionPlanFamilies: config.teamBillingEnabled
        ? ["individual_pro", "team_standard"]
        : ["individual_pro"],
      topupUnitTypes: [
        ...(config.creem.creditTopupProductId ? ["credit" as const] : []),
        ...(config.creem.pageTopupProductId ? ["page" as const] : []),
      ],
    });
  }
}
