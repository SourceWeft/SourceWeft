/**
 * Shared error-message resolution for SSO provider-management calls.
 *
 * Two kinds of error reach the provider-management UI:
 *   1. SourceWeft backend errors (guard / policy / provisioning), which already
 *      carry an already-localized `message` (the auth client sends `x-sw-locale`)
 *      and a `SSO_*` `code`.
 *   2. Errors from the `@better-auth/sso` plugin itself, whose messages are
 *      English only. These must never be shown verbatim in a non-English UI, so
 *      they are mapped to localized copy by `code`, or fall back to the generic
 *      localized error.
 * A 429 (register/verify are IP rate-limited) is turned into the localized
 * "too many attempts" message regardless of the English body.
 */
export type SsoClientError =
  | {
      status?: number
      code?: string | null
      message?: string | null
    }
  | null
  | undefined

/** The localization keys this module reads (a subset of `SsoLocalization`). */
export type SsoErrorLocalization = {
  orgRateLimited: string
  orgErrDomainVerificationFailed: string
  orgErrNoPendingVerification: string
  orgErrInvalidDomain: string
  orgErrIdentifierTooLong: string
  orgErrProviderChanged: string
}

/**
 * Plugin-native (English-only) error codes mapped to localized copy. Confirmed
 * against `@better-auth/sso` dist: `DOMAIN_VERIFICATION_FAILED` (502),
 * `NO_PENDING_VERIFICATION` / `IDENTIFIER_TOO_LONG` / `INVALID_DOMAIN` (verify /
 * request-domain-verification) and `SSO_PROVIDER_CHANGED` (mutation race).
 */
const PLUGIN_CODE_TO_KEY: Record<string, keyof SsoErrorLocalization> = {
  DOMAIN_VERIFICATION_FAILED: "orgErrDomainVerificationFailed",
  NO_PENDING_VERIFICATION: "orgErrNoPendingVerification",
  INVALID_DOMAIN: "orgErrInvalidDomain",
  IDENTIFIER_TOO_LONG: "orgErrIdentifierTooLong",
  SSO_PROVIDER_CHANGED: "orgErrProviderChanged"
}

/**
 * SourceWeft backend SSO codes whose `message` is already localized and may be
 * shown as-is. Any other error (a raw plugin English message, an uncoded error)
 * falls back to the generic localized message so no English plugin text ever
 * reaches a non-English UI.
 */
const SOURCEWEFT_LOCALIZED_CODES = new Set([
  "SSO_PROVIDER_NOT_FOUND",
  "SSO_DOMAIN_NOT_VERIFIED",
  "SSO_DOMAIN_NOT_ALLOWED",
  "SSO_ACCOUNT_LINK_DENIED",
  "SSO_SEAT_LIMIT",
  "SSO_PROVISIONING_FAILED",
  "SSO_INVALID_ROLE_ATTRIBUTE",
  "SSO_ORGANIZATION_REQUIRED",
  "SSO_PROVIDER_LIMIT",
  "SSO_SAML_ALGORITHM_NOT_ALLOWED",
  "SSO_INVALID_PROVIDER_ID",
  "SSO_PROVIDER_IDENTITY_LOCKED"
])

/** OIDC discovery / issuer-reachability error codes from `@better-auth/sso`. */
export const SSO_DISCOVERY_CODES = new Set([
  "discovery_timeout",
  "discovery_unexpected_error",
  "discovery_not_found",
  "discovery_invalid_url",
  "discovery_untrusted_origin",
  "discovery_private_host",
  "oidc_endpoint_redirect",
  "discovery_invalid_json",
  "discovery_incomplete",
  "issuer_mismatch",
  "unsupported_token_auth_method"
])

/**
 * Resolves a single localized message for an SSO error. Used by the domain
 * verification panel, the delete dialog and the provider-list load, and as the
 * dialog's form-level fallback.
 */
export function ssoErrorMessage(
  error: SsoClientError,
  localization: SsoErrorLocalization,
  genericMessage: string
): string {
  if (error?.status === 429) return localization.orgRateLimited
  const code = error?.code ?? ""
  const mapped = PLUGIN_CODE_TO_KEY[code]
  if (mapped) return localization[mapped]
  if (SOURCEWEFT_LOCALIZED_CODES.has(code) && error?.message) return error.message
  return genericMessage
}
