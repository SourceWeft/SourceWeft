/**
 * Maps an identity provider's role claim onto the organization role an SSO
 * sign-in may assign.
 *
 * Enterprise SSO never grants or revokes `owner`: the only roles it can assign
 * are `member` and `admin` (see global constraints and plan Review Focus 4).
 * A member is promoted to `admin` only when the provider is configured with a
 * `roleAttribute` and an `adminRoleValue`, and the claim the IdP returns carries
 * that exact value — as the whole string, or as one element of a string array.
 *
 * The role claim never reaches `userInfo` under the tenant-chosen attribute name
 * (that could be a user-table column such as `role` or `email`). The guard maps
 * it into a FIXED, namespaced key, {@link SSO_ROLE_CLAIM_KEY}, which is not a
 * user field and so is dropped by the plugin's user-input parsing; this reads
 * that key.
 *
 * Deliberately strict, because this decides an administrative grant:
 *  - no `roleAttribute` / `adminRoleValue` (unconfigured, or empty) → `member`;
 *  - the value is matched whole, never split: a comma-joined `"dev,sw-admins"`
 *    is not treated as containing `"sw-admins"`;
 *  - a non-string, non-array value (object, number, boolean, null) → `member`.
 */

/**
 * The fixed `userInfo` key the guard maps a tenant's role claim into. It is not a
 * user-table field, so the plugin never writes it to the user row, and the
 * tenant's chosen attribute name can be anything — including a user column name —
 * without corrupting the user's profile.
 */
export const SSO_ROLE_CLAIM_KEY = "ssoRoleClaim";

/** Upper bound on a role attribute name; a claim key is never this long. */
export const MAX_ROLE_ATTRIBUTE_LENGTH = 128;

export type RoleAttributeValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "too_long" | "control_characters" };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validate a non-empty role attribute name the way provider registration must: a
 * trimmed string of at most {@link MAX_ROLE_ATTRIBUTE_LENGTH} characters with no
 * control characters. The name may be ANY claim/attribute name (even a user
 * column name like `role` or `email`) — the guard maps it into
 * {@link SSO_ROLE_CLAIM_KEY}, so it cannot overwrite the user's profile. Callers
 * normalize an empty or absent attribute (which clears role mapping) first.
 */
export function validateRoleAttribute(raw: string): RoleAttributeValidation {
  const value = raw.trim();
  if (value.length > MAX_ROLE_ATTRIBUTE_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return { ok: false, reason: "control_characters" };
  }
  return { ok: true, value };
}

export function mapSsoRole(input: {
  userInfo: Record<string, unknown>;
  roleManaged: boolean;
  adminRoleValue: string | null;
}): "member" | "admin" {
  const { userInfo, roleManaged, adminRoleValue } = input;

  // An unconfigured mapping, or an empty admin value, never promotes.
  if (!roleManaged || !adminRoleValue) {
    return "member";
  }

  const value = userInfo[SSO_ROLE_CLAIM_KEY];

  if (typeof value === "string") {
    return value === adminRoleValue ? "admin" : "member";
  }

  if (Array.isArray(value)) {
    return value.some((entry) => entry === adminRoleValue) ? "admin" : "member";
  }

  return "member";
}
