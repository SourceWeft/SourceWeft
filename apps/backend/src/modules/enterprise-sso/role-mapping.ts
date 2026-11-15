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
