export const DEFAULT_CREDIT_UNIT_USD = 0.00125;

export type CreditComputationInput = {
  providerCostUsd: number;
  platformCostUsd?: number;
  markupRate?: number;
  creditUnitUsd?: number;
};

function assertNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
}

export function toCreditsFromUsd(
  usd: number,
  creditUnitUsd = DEFAULT_CREDIT_UNIT_USD,
) {
  assertNonNegative(usd, "usd");

  if (!Number.isFinite(creditUnitUsd) || creditUnitUsd <= 0) {
    throw new Error("creditUnitUsd must be a positive number");
  }

  return Math.ceil(usd / creditUnitUsd);
}

export function toUsdFromCredits(
  credits: number,
  creditUnitUsd = DEFAULT_CREDIT_UNIT_USD,
) {
  assertNonNegative(credits, "credits");

  if (!Number.isFinite(creditUnitUsd) || creditUnitUsd <= 0) {
    throw new Error("creditUnitUsd must be a positive number");
  }

  return credits * creditUnitUsd;
}

export function computeCreditsFromCost({
  providerCostUsd,
  platformCostUsd = 0,
  markupRate = 0,
  creditUnitUsd = DEFAULT_CREDIT_UNIT_USD,
}: CreditComputationInput) {
  assertNonNegative(providerCostUsd, "providerCostUsd");
  assertNonNegative(platformCostUsd, "platformCostUsd");
  assertNonNegative(markupRate, "markupRate");

  const totalUsd = (providerCostUsd + platformCostUsd) * (1 + markupRate);
  return toCreditsFromUsd(totalUsd, creditUnitUsd);
}
