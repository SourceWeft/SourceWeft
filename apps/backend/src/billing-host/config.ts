export type SourceweftEdition = "core" | "commercial";
type Environment = Readonly<Record<string, string | undefined>>;

const billingFlags = [
  "SOURCEWEFT_SAAS_ENABLED",
  "BACKEND_TEAM_BILLING_ENABLED",
  "BACKEND_BILLING_RECONCILE_ENABLED",
  "BACKEND_CREDITS_ENABLED",
  "BACKEND_PAGES_ENABLED",
] as const;

/** Credentials never select an edition or activate a billing feature. */
export function assertEditionConfiguration(
  edition: SourceweftEdition,
  env: Environment,
): void {
  const requested = env.SOURCEWEFT_EDITION?.trim();
  if (requested !== undefined && requested !== edition) {
    throw new Error(`SOURCEWEFT_EDITION does not match the ${edition} build`);
  }
  if (edition !== "core") return;
  for (const name of billingFlags) {
    const value = env[name];
    if (value === undefined) continue;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      throw new Error(`${name} requires a commercial billing build`);
    }
    if (!["false", "0", "no", "off", "disabled"].includes(normalized)) {
      throw new Error(`${name} must be an explicit boolean`);
    }
  }
  if (
    env.BACKEND_BILLING_MODE !== undefined &&
    env.BACKEND_BILLING_MODE.trim().toLowerCase() !== "disabled"
  ) {
    throw new Error(
      "BACKEND_BILLING_MODE requires a commercial billing build unless disabled",
    );
  }
  if (
    env.BACKEND_BILLING_PROVIDER !== undefined &&
    env.BACKEND_BILLING_PROVIDER.trim().toLowerCase() !== "none"
  ) {
    throw new Error(
      "BACKEND_BILLING_PROVIDER requires a commercial billing build unless none",
    );
  }
}
