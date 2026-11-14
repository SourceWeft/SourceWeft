import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import { ssoSecretStoragePlugin } from "./secret-storage";

/**
 * Registers the better-auth SSO plugin (OIDC + SAML) for team organizations,
 * alongside {@link ssoSecretStoragePlugin}, which encrypts the OIDC
 * clientSecret at rest.
 *
 * Guards and user provisioning are later tasks; `provisionUser` is
 * deliberately not configured yet.
 *
 * `isRuntimeMode` is accepted (not yet used) for parity with the other
 * plugins in `auth-config.ts`, which gate runtime-only side effects (mail
 * sends, lazy imports that would otherwise cycle with auth-config) behind
 * this flag. A later task's `provisionUser` callback is expected to need it.
 */
export function buildSsoPlugins({
  isRuntimeMode: _isRuntimeMode,
}: {
  isRuntimeMode: boolean;
}): BetterAuthPlugin[] {
  return [
    // Seals the OIDC clientSecret in `ssoProvider.oidcConfig` at the adapter
    // layer (better-auth databaseHooks don't cover plugin tables). Registered
    // next to the SSO plugin so `auth migrate` still creates the table and so
    // the wrap is applied in both runtime and migration modes.
    ssoSecretStoragePlugin(),
    sso({
      // Identity sources only belong to `team` organizations; account
      // linking relies solely on a verified domain + matching email domain,
      // never on provider-asserted email_verified (trustEmailVerified stays
      // unset/false).
      domainVerification: {
        enabled: true,
        tokenPrefix: "sourceweft-sso",
      },
      // Organizations are provisioned by the existing `organization` plugin
      // hooks (see auth-config.ts); SSO sign-in must not create its own.
      organizationProvisioning: {
        disabled: true,
      },
      // Upstream IdP profile changes (e.g. a role attribute change) should
      // apply on every sign-in, not just first registration.
      provisionUserOnEveryLogin: true,
      providersLimit: 25,
      redirectURI: "/sso/callback",
      saml: {
        enableInResponseToValidation: true,
        allowIdpInitiated: false,
        requireTimestamps: true,
        algorithms: {
          onDeprecated: "reject",
        },
        enableSingleLogout: false,
      },
      schema: {
        ssoProvider: {
          additionalFields: {
            // Attribute/claim name the IdP returns the member's role in, and
            // the value that maps to the `admin` organization role. A later
            // guard reads these; IdP role mapping never grants or revokes
            // `owner`.
            roleAttribute: {
              type: "string",
              required: false,
            },
            adminRoleValue: {
              type: "string",
              required: false,
            },
          },
        },
      },
    }),
  ];
}
