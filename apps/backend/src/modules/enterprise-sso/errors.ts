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
  organizationRequired: "SSO_ORGANIZATION_REQUIRED",
  // Per-organization provider cap (Task 3's guard); providersLimit on the
  // plugin itself enforces the per-user cap registered in this task.
  providerLimit: "SSO_PROVIDER_LIMIT",
} as const;

export type SsoErrorCode = (typeof SSO_ERROR_CODES)[keyof typeof SSO_ERROR_CODES];
