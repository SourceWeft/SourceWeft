function readBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return fallback;
}

export const sourceweftSaasEnabled = readBooleanEnv(
  process.env.NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED,
  false,
);

export const billingCheckoutEnabled = readBooleanEnv(
  process.env.NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED,
  sourceweftSaasEnabled,
);
