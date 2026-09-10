type Environment = Readonly<Record<string, string | undefined>>;

const billingFlags = [
  "SOURCEWEFT_SAAS_ENABLED",
  "BACKEND_TEAM_BILLING_ENABLED",
  "BACKEND_BILLING_RECONCILE_ENABLED",
  "BACKEND_CREDITS_ENABLED",
  "BACKEND_PAGES_ENABLED",
] as const;

function boolean(env: Environment, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      throw new Error(`${name} must be true, false, 1, or 0`);
  }
}

/** Deployment intent only. Credentials never enable the commercial module. */
export function resolveCommercialEnabled(env: Environment): boolean {
  const enabled = boolean(env, "SOURCEWEFT_COMMERCIAL_ENABLED") ?? false;
  const edition = env.SOURCEWEFT_EDITION?.trim();
  if (edition !== undefined && edition !== (enabled ? "commercial" : "core")) {
    throw new Error(
      "SOURCEWEFT_EDITION is obsolete and conflicts with SOURCEWEFT_COMMERCIAL_ENABLED; remove it and use the explicit module switch",
    );
  }
  for (const name of billingFlags) {
    if (boolean(env, name) && !enabled) {
      throw new Error(`${name} requires SOURCEWEFT_COMMERCIAL_ENABLED=true`);
    }
  }
  if (
    !enabled &&
    env.BACKEND_BILLING_MODE !== undefined &&
    env.BACKEND_BILLING_MODE.trim().toLowerCase() !== "disabled"
  ) {
    throw new Error(
      "BACKEND_BILLING_MODE requires SOURCEWEFT_COMMERCIAL_ENABLED=true unless disabled",
    );
  }
  if (
    !enabled &&
    env.BACKEND_BILLING_PROVIDER !== undefined &&
    env.BACKEND_BILLING_PROVIDER.trim().toLowerCase() !== "none"
  ) {
    throw new Error(
      "BACKEND_BILLING_PROVIDER requires SOURCEWEFT_COMMERCIAL_ENABLED=true unless none",
    );
  }
  return enabled;
}
