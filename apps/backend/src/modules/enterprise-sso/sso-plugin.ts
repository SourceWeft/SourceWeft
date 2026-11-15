import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import { sourceweftSsoGuard } from "./guard-plugin";
import { mapSsoRole } from "./role-mapping";
import {
  provisionSsoUser,
  resolveSsoSignIn,
  type SsoResolutionAdapter,
} from "./provisioning";
import { ssoSecretStoragePlugin } from "./secret-storage";

/** The persisted `ssoProvider` fields the provisioning hooks read at sign-in. */
type SsoProviderRuntimeRow = {
  providerId: string;
  organizationId?: unknown;
  domain?: unknown;
  roleAttribute?: unknown;
  adminRoleValue?: unknown;
  samlConfig?: unknown;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Registers the better-auth SSO plugin (OIDC + SAML) for team organizations,
 * together with:
 *  - {@link ssoSecretStoragePlugin}, which encrypts the OIDC clientSecret at
 *    rest, and
 *  - {@link sourceweftSsoGuard}, which enforces the SourceWeft multi-tenant
 *    rules (team-only orgs, private/unique domains, provider cap, signed SAML,
 *    the SAML ACS algorithm policy), maps the plugin's own errors to localized
 *    codes, and records the per-request facts provisioning needs.
 *
 * `resolveUser` fails closed on the account-linking rules (domain mismatch, an
 * unverified pre-existing account) before any row is created; `provisionUser`
 * adds the signed-in user to the provider's organization after the transaction
 * commits. Registered outside the `isRuntimeMode` branching in auth-config.ts so
 * `auth migrate` still creates the plugin's table.
 */
export function buildSsoPlugins(): BetterAuthPlugin[] {
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
      // Backstop the before-hook guard: a provider that somehow lost its
      // organization (e.g. a legacy or defaultSSO row) can never be updated or
      // deleted. Registration already requires a team organization, so every
      // provider the guard admits is organization-bound. The plugin wraps any
      // throw here into its stable conflict response.
      guardProviderMutation: ({ provider }) => {
        if (provider.organizationId === null) {
          throw new Error(
            "SSO providers must belong to a team organization.",
          );
        }
      },
      // Decide, inside the sign-in transaction and before any user/account/
      // session row exists, whether a verified identity may sign in and to
      // which user. All reads go through the transaction adapter (`database`),
      // so the resolver never acquires a second pooled connection while it
      // holds the provider row lock.
      resolveUser: async (input, { database }) =>
        resolveSsoSignIn({
          providerId: input.providerId,
          email: input.providerUser.email,
          database: database as unknown as SsoResolutionAdapter,
        }),
      // Add the signed-in user to the provider's organization through the real
      // member-added path, reconcile a managed role, and audit the sign-in.
      // Runs after the session is committed; whether this sign-in created the
      // user row (for the audit's `isNewUser`) and which session to revoke on a
      // failed add are read from the guard's capture, not passed here.
      provisionUser: async ({ user, userInfo, provider }) => {
        const row = provider as unknown as SsoProviderRuntimeRow;
        const organizationId = nonEmptyString(row.organizationId);
        if (!organizationId) {
          // An organization-less provider is never routed to at sign-in; nothing
          // to provision into.
          return;
        }
        const protocol: "oidc" | "saml" = row.samlConfig ? "saml" : "oidc";
        const roleAttribute = nonEmptyString(row.roleAttribute);
        const role = mapSsoRole({
          userInfo,
          roleAttribute,
          adminRoleValue: nonEmptyString(row.adminRoleValue),
        });
        await provisionSsoUser({
          userId: user.id,
          organizationId,
          role,
          providerId: row.providerId,
          protocol,
          domain: nonEmptyString(row.domain) ?? "",
          roleManaged: roleAttribute !== null,
        });
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
            // the value that maps to the `admin` organization role. The guard
            // reads these; IdP role mapping never grants or revokes `owner`.
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
    // Enforces the SourceWeft multi-tenant rules (team-only organizations,
    // private/unique domains, per-organization provider cap, signed SAML
    // assertions) on `/sso/register` and `/sso/update-provider`.
    sourceweftSsoGuard(),
  ];
}
