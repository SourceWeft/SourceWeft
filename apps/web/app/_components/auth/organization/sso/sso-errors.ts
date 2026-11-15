/**
 * Shared error-message resolution for SSO provider-management calls.
 *
 * The register/verify endpoints are IP rate-limited (register 10/60s,
 * verify-domain 6/60s); better-auth's own 429 body is English, so a 429 gets a
 * localized "too many attempts" message. Every other error already carries the
 * backend's localized `message` (the auth client sends `x-sw-locale`), so that
 * is shown as-is, falling back to the generic localized error.
 */
export type SsoClientError = {
  status?: number
  code?: string
  message?: string | null
} | null | undefined

export function ssoErrorMessage(
  error: SsoClientError,
  rateLimitedMessage: string,
  genericMessage: string
): string {
  if (error?.status === 429) return rateLimitedMessage
  return error?.message || genericMessage
}
