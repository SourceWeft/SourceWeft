import type { PlanConfig } from "@sourceweft/contracts/pricing";
/** Core deployments make no subscription offers. */
export function getPricingConfig(): PlanConfig[] {
  return [];
}

export const billingUiAvailable = false;
