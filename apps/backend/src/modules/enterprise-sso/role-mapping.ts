/**
 * Maps an identity provider's role attribute onto the organization role an SSO
 * sign-in may assign.
 *
 * Enterprise SSO never grants or revokes `owner`: the only roles it can assign
 * are `member` and `admin` (see global constraints and plan Review Focus 4).
 * A member is promoted to `admin` only when the provider is configured with a
 * `roleAttribute` and an `adminRoleValue`, and the claim the IdP returns under
 * `roleAttribute` carries that exact value — as the whole string, or as one
 * element of a string array.
 *
 * Deliberately strict, because this decides an administrative grant:
 *  - no `roleAttribute` / `adminRoleValue` (unconfigured, or an empty
 *    `adminRoleValue`) → `member`;
 *  - the value is matched whole, never split: a comma-joined `"dev,sw-admins"`
 *    is not treated as containing `"sw-admins"`;
 *  - a non-string, non-array value (object, number, boolean, null) → `member`.
 */
/**
 * Profile-mapping keys an IdP's role claim may never reuse. These name the
 * identity fields the plugin maps directly (`email`, `name`, …); carrying a role
 * claim under one of them would overwrite the mapped identity in `userInfo`.
 */
export const RESERVED_SSO_MAPPING_KEYS = [
  "id",
  "email",
  "emailVerified",
  "name",
  "image",
] as const;

/** Upper bound on a role attribute name; a claim key is never this long. */
export const MAX_ROLE_ATTRIBUTE_LENGTH = 128;

export type RoleAttributeValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "reserved" | "too_long" };

/**
 * Validate a non-empty role attribute name the way provider registration must:
 * a trimmed string of at most {@link MAX_ROLE_ATTRIBUTE_LENGTH} characters that
 * is not one of {@link RESERVED_SSO_MAPPING_KEYS}. Callers normalize an empty or
 * absent attribute (which clears role mapping) before calling this.
 */
export function validateRoleAttribute(raw: string): RoleAttributeValidation {
  const value = raw.trim();
  if (value.length > MAX_ROLE_ATTRIBUTE_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  if ((RESERVED_SSO_MAPPING_KEYS as readonly string[]).includes(value)) {
    return { ok: false, reason: "reserved" };
  }
  return { ok: true, value };
}

export function mapSsoRole(input: {
  userInfo: Record<string, unknown>;
  roleAttribute: string | null;
  adminRoleValue: string | null;
}): "member" | "admin" {
  const { userInfo, roleAttribute, adminRoleValue } = input;

  // An unconfigured mapping, or an empty admin value, never promotes.
  if (!roleAttribute || !adminRoleValue) {
    return "member";
  }

  const value = userInfo[roleAttribute];

  if (typeof value === "string") {
    return value === adminRoleValue ? "admin" : "member";
  }

  if (Array.isArray(value)) {
    return value.some((entry) => entry === adminRoleValue) ? "admin" : "member";
  }

  return "member";
}
