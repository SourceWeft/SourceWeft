import { APIError } from "better-auth/api";

/**
 * Error codes for enterprise SSO (OIDC + SAML for team organizations).
 * Declared here so later tasks (guards, provisioning, UI) share one catalog;
 * this task only registers the plugin and does not throw any of these yet.
 */
export const SSO_ERROR_CODES = {
  providerNotFound: "SSO_PROVIDER_NOT_FOUND",
  domainNotVerified: "SSO_DOMAIN_NOT_VERIFIED",
  domainNotAllowed: "SSO_DOMAIN_NOT_ALLOWED",
  accountLinkDenied: "SSO_ACCOUNT_LINK_DENIED",
  seatLimit: "SSO_SEAT_LIMIT",
  // The membership step failed after the session was created for a reason other
  // than a seat limit (e.g. addMember threw); the sign-in is rolled back.
  provisioningFailed: "SSO_PROVISIONING_FAILED",
  // A provider was registered/updated with a role attribute that collides with a
  // reserved profile-mapping key or is otherwise unusable.
  invalidRoleAttribute: "SSO_INVALID_ROLE_ATTRIBUTE",
  organizationRequired: "SSO_ORGANIZATION_REQUIRED",
  // Per-organization provider cap (Task 3's guard); providersLimit on the
  // plugin itself enforces the per-user cap registered in this task.
  providerLimit: "SSO_PROVIDER_LIMIT",
} as const;

export type SsoErrorCode = (typeof SSO_ERROR_CODES)[keyof typeof SSO_ERROR_CODES];

/**
 * The single English-language source of truth for every {@link SSO_ERROR_CODES}
 * message (design §16 / task 7). `apps/backend/src/modules/auth/auth-error-i18n.ts`
 * spreads this table into `authErrorTranslations.en` (and `.zh`/`"zh-CN"` carry
 * the Simplified Chinese counterpart, `"zh-TW"` the reviewed Taiwan Traditional
 * one) so the official `@better-auth/i18n` plugin can translate a handler-level
 * throw of one of these codes. Every throw site in this module instead uses
 * {@link ssoError} below, so this table is the only place an English SSO
 * message literal exists — nowhere else duplicates or re-derives it.
 */
export const SSO_ERROR_MESSAGES_EN: Record<SsoErrorCode, string> = {
  [SSO_ERROR_CODES.providerNotFound]:
    "No single sign-on is set up for this email address.",
  [SSO_ERROR_CODES.domainNotVerified]:
    "This domain has not been verified yet. Ask your administrator to finish setup.",
  [SSO_ERROR_CODES.domainNotAllowed]:
    "This domain cannot be used for single sign-on.",
  [SSO_ERROR_CODES.accountLinkDenied]:
    "This sign-in cannot be linked to an existing account. Contact your administrator.",
  [SSO_ERROR_CODES.seatLimit]:
    "Your team has no seats left. Ask your administrator to add seats.",
  [SSO_ERROR_CODES.provisioningFailed]:
    "We couldn't add you to your team. Try again, or contact your administrator.",
  [SSO_ERROR_CODES.invalidRoleAttribute]:
    "This role attribute name can't be used. Choose a different attribute.",
  [SSO_ERROR_CODES.organizationRequired]:
    "Single sign-on can only be set up for a team.",
  [SSO_ERROR_CODES.providerLimit]:
    "This team has reached the limit of 5 identity providers.",
};

/**
 * Builds the `APIError` for an {@link SsoErrorCode}, with its `message` taken
 * from {@link SSO_ERROR_MESSAGES_EN} — the one place every throw site in
 * `guard-plugin.ts` / `policy.ts` gets its English text from, so none of them
 * carries its own copy of the literal.
 */
export function ssoError(
  code: SsoErrorCode,
  status: ConstructorParameters<typeof APIError>[0],
): APIError {
  return new APIError(status, { code, message: SSO_ERROR_MESSAGES_EN[code] });
}
