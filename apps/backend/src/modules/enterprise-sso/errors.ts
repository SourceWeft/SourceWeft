import { APIError } from "better-auth/api";
import { config } from "../../shared/config";

/**
 * Error codes for enterprise SSO (OIDC + SAML for team organizations). This one
 * catalog is shared by every throw site in the module — the guard before-hooks
 * (`guard-plugin.ts`, `policy.ts`), the sign-in resolver and provisioning
 * (`provisioning.ts`) and the SAML algorithm policy — so a code and its English
 * message are defined in exactly one place ({@link SSO_ERROR_MESSAGES_EN}).
 */
export const SSO_ERROR_CODES = {
  providerNotFound: "SSO_PROVIDER_NOT_FOUND",
  domainNotVerified: "SSO_DOMAIN_NOT_VERIFIED",
  domainNotAllowed: "SSO_DOMAIN_NOT_ALLOWED",
  accountLinkDenied: "SSO_ACCOUNT_LINK_DENIED",
  seatLimit: "SSO_SEAT_LIMIT",
  // The membership step failed after the session was created for a reason other
  // than a seat limit (e.g. addMember threw); only the created session is
  // revoked and the sign-in is redirected to the error page.
  provisioningFailed: "SSO_PROVISIONING_FAILED",
  // A provider was registered/updated with a role attribute that is unusable
  // (over-long, or contains control characters).
  invalidRoleAttribute: "SSO_INVALID_ROLE_ATTRIBUTE",
  // A provider's `mapping.extraFields` used a key that is a field of the user
  // table, which would let the IdP write that user column (or trigger a plugin's
  // user-create hook) during sign-in.
  invalidAttributeMapping: "SSO_INVALID_ATTRIBUTE_MAPPING",
  // A provider id outside `^[a-z0-9-]{3,47}$` was submitted at registration; a
  // longer id would overflow the `_sourceweft-sso-<providerId>` DNS TXT label.
  invalidProviderId: "SSO_INVALID_PROVIDER_ID",
  organizationRequired: "SSO_ORGANIZATION_REQUIRED",
  // Per-organization provider cap (the guard); providersLimit on the plugin
  // itself enforces the per-user cap.
  providerLimit: "SSO_PROVIDER_LIMIT",
  // An update tried to change a provider's identity fields (issuer, OIDC client
  // id/endpoints, SAML certificate / entity id / sign-on URL) after at least one
  // account had already linked through it; the plugin answers 409 and the guard
  // surfaces it under this code.
  providerIdentityLocked: "SSO_PROVIDER_IDENTITY_LOCKED",
  // A SAML response declared a signature or digest algorithm outside the
  // allow-list (SHA-1 and friends), or an encrypted assertion, so the guard's
  // algorithm policy rejected it before the plugin could verify it.
  samlAlgorithmNotAllowed: "SSO_SAML_ALGORITHM_NOT_ALLOWED",
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
  [SSO_ERROR_CODES.invalidAttributeMapping]:
    "This attribute mapping uses a name that is reserved. Choose a different field name.",
  [SSO_ERROR_CODES.invalidProviderId]:
    "Provider IDs use 3–47 lowercase letters, digits and hyphens.",
  [SSO_ERROR_CODES.organizationRequired]:
    "Single sign-on can only be set up for a team.",
  [SSO_ERROR_CODES.providerLimit]:
    "This team has reached the limit of 5 identity providers.",
  [SSO_ERROR_CODES.providerIdentityLocked]:
    "These settings can't be changed after members have signed in with this provider. To change them, delete the provider and add it again.",
  [SSO_ERROR_CODES.samlAlgorithmNotAllowed]:
    "Your identity provider's SAML response uses signature settings that aren't supported. Ask your administrator to sign with SHA-256 and to send unencrypted assertions.",
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

/**
 * Builds the error-URL redirect for a failed SSO sign-in callback. A `FOUND`
 * `APIError` with a `location` header is exactly what the plugin's own
 * `ctx.redirect(...)` produces for a resolver rejection, so thrown from inside
 * (or a before-hook of) a callback endpoint it yields a clean 302 to the error
 * page carrying the `code` — never a raw error body, and never a session cookie
 * (the plugin sets that only on a successful sign-in). Used both by
 * provisioning.ts (a membership step that fails after the session is committed)
 * and by the guard's SAML algorithm policy (a rejection before the plugin
 * processes the response). The optional `cause` is kept non-enumerable so it is
 * skipped by `JSON.stringify` and never leaks into the serialized body.
 */
export function ssoErrorRedirect(code: SsoErrorCode, cause?: unknown): APIError {
  const url = new URL(config.auth.errorUrl);
  url.searchParams.set("error", code);
  const error = new APIError(
    "FOUND",
    undefined,
    new Headers({ location: url.toString() }),
  );
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      value: cause,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}
