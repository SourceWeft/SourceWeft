import { getPlanQuota } from "@sourceweft/credits-core";
import type {
  BillingInterval,
  PricingCheckoutPlan,
  SubscriptionPlanFamily,
  TopupUnitType,
} from "@sourceweft/contracts";
import { BillingError } from "./errors";
import type { BillingRuntimeConfig } from "./types";

type SubscriptionCatalogEntry = {
  planFamily: SubscriptionPlanFamily;
  audience: "personal" | "team";
  defaultQuantity: number;
  minQuantity: number;
  quotaSeatCount: number;
  monthlyAmountCents: number;
  yearlyAmountCents: number;
  monthlyProductId: string;
  yearlyProductId: string;
};

type TopupCatalogEntry = {
  kind: "credit_topup" | "page_topup";
  unitType: TopupUnitType;
  unitAmount: number;
  amountCents: number;
  productId: string;
};

export type BillingCatalog = {
  subscriptions: Record<SubscriptionPlanFamily, SubscriptionCatalogEntry>;
  topups: Record<TopupUnitType, TopupCatalogEntry>;
};

export type PricingDisplayPlan = {
  id: "free" | "pro" | "team";
  monthlyPrice: number;
  yearlyPrice: number;
};

export function createBillingCatalog(
  runtimeConfig: BillingRuntimeConfig,
): BillingCatalog {
  return {
    subscriptions: {
      individual_pro: {
        planFamily: "individual_pro",
        audience: "personal",
        defaultQuantity: 1,
        minQuantity: 1,
        quotaSeatCount: 1,
        monthlyAmountCents:
          runtimeConfig.catalog.individualProMonthlyAmountCents,
        yearlyAmountCents: runtimeConfig.catalog.individualProYearlyAmountCents,
        monthlyProductId: runtimeConfig.creem.individualProMonthlyProductId,
        yearlyProductId: runtimeConfig.creem.individualProYearlyProductId,
      },
      team_standard: {
        planFamily: "team_standard",
        audience: "team",
        defaultQuantity: 2,
        minQuantity: 2,
        quotaSeatCount: 2,
        monthlyAmountCents:
          runtimeConfig.catalog.teamStandardMonthlyAmountCents,
        yearlyAmountCents: runtimeConfig.catalog.teamStandardYearlyAmountCents,
        monthlyProductId: runtimeConfig.creem.teamStandardMonthlyProductId,
        yearlyProductId: runtimeConfig.creem.teamStandardYearlyProductId,
      },
    },
    topups: {
      credit: {
        kind: "credit_topup",
        unitType: "credit",
        unitAmount: runtimeConfig.catalog.creditTopupUnitAmount,
        amountCents: runtimeConfig.catalog.creditTopupAmountCents,
        productId: runtimeConfig.creem.creditTopupProductId,
      },
      page: {
        kind: "page_topup",
        unitType: "page",
        unitAmount: runtimeConfig.catalog.pageTopupUnitAmount,
        amountCents: runtimeConfig.catalog.pageTopupAmountCents,
        productId: runtimeConfig.creem.pageTopupProductId,
      },
    },
  };
}

export function pricingPlanToPlanFamily(
  plan: PricingCheckoutPlan,
): SubscriptionPlanFamily {
  return plan === "pro" ? "individual_pro" : "team_standard";
}

export function getSubscriptionCatalogEntry(
  runtimeConfig: BillingRuntimeConfig,
  planFamily: SubscriptionPlanFamily,
) {
  return createBillingCatalog(runtimeConfig).subscriptions[planFamily];
}

export function getTopupCatalogEntry(
  runtimeConfig: BillingRuntimeConfig,
  unitType: TopupUnitType,
) {
  return createBillingCatalog(runtimeConfig).topups[unitType];
}

export function resolveSubscriptionProduct(input: {
  runtimeConfig: BillingRuntimeConfig;
  planFamily: SubscriptionPlanFamily;
  billingInterval: Exclude<BillingInterval, "unknown">;
}) {
  const entry = getSubscriptionCatalogEntry(
    input.runtimeConfig,
    input.planFamily,
  );
  return {
    productId:
      input.billingInterval === "monthly"
        ? entry.monthlyProductId
        : entry.yearlyProductId,
    amountCents:
      input.billingInterval === "monthly"
        ? entry.monthlyAmountCents
        : entry.yearlyAmountCents,
    currency: "usd",
  };
}

export function validateBillingCatalog(input: {
  runtimeConfig: BillingRuntimeConfig;
  pricingDisplay?: PricingDisplayPlan[];
  subscriptionPlanFamilies?: SubscriptionPlanFamily[];
  topupUnitTypes?: TopupUnitType[];
}) {
  const catalog = createBillingCatalog(input.runtimeConfig);
  const errors: string[] = [];
  const providerRequiresProducts = input.runtimeConfig.provider === "creem";
  const subscriptionEntries = input.subscriptionPlanFamilies
    ? input.subscriptionPlanFamilies.map(
        (planFamily) => catalog.subscriptions[planFamily],
      )
    : Object.values(catalog.subscriptions);
  const topupEntries = input.topupUnitTypes
    ? input.topupUnitTypes.map((unitType) => catalog.topups[unitType])
    : Object.values(catalog.topups);

  for (const entry of subscriptionEntries) {
    const quota = getPlanQuota(entry.planFamily, entry.quotaSeatCount);
    if (quota.monthlyCreditsGrant <= 0 || quota.monthlyPagesLimit <= 0) {
      errors.push(`Missing quota for active plan ${entry.planFamily}`);
    }

    if (providerRequiresProducts) {
      if (!entry.monthlyProductId) {
        errors.push(`Missing monthly provider product for ${entry.planFamily}`);
      }

      if (!entry.yearlyProductId) {
        errors.push(`Missing yearly provider product for ${entry.planFamily}`);
      }
    }
  }

  for (const entry of topupEntries) {
    if (entry.unitAmount <= 0) {
      errors.push(`Missing unit amount for ${entry.unitType} top-up`);
    }

    if (entry.amountCents <= 0) {
      errors.push(`Missing amount for ${entry.unitType} top-up`);
    }

    if (providerRequiresProducts && !entry.productId) {
      errors.push(`Missing provider product for ${entry.unitType} top-up`);
    }
  }

  if (input.pricingDisplay) {
    const pro = input.pricingDisplay.find((plan) => plan.id === "pro");
    const team = input.pricingDisplay.find((plan) => plan.id === "team");
    if (
      pro &&
      (pro.monthlyPrice !==
        catalog.subscriptions.individual_pro.monthlyAmountCents ||
        pro.yearlyPrice !==
          catalog.subscriptions.individual_pro.yearlyAmountCents)
    ) {
      errors.push("Pricing display amount differs from individual_pro catalog");
    }

    if (
      team &&
      (team.monthlyPrice !==
        catalog.subscriptions.team_standard.monthlyAmountCents ||
        team.yearlyPrice !==
          catalog.subscriptions.team_standard.yearlyAmountCents)
    ) {
      errors.push("Pricing display amount differs from team_standard catalog");
    }
  }

  if (errors.length > 0) {
    throw new BillingError(
      "BILLING_CATALOG_INVALID",
      500,
      "Billing catalog validation failed",
      { errors },
    );
  }

  return catalog;
}
