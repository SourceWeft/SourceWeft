import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import { sourceweftSsoGuard } from "./guard-plugin";
import { mapSsoRole } from "./role-mapping";
import {
  provisionSsoUser,
  rememberSsoIsNewUser,
  resolveSsoSignIn,
  takeSsoIsNewUser,
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
      // which user. `@better-auth/sso@1.7.7` runs `provisionUser` AFTER the
      // session is created, so the fail-closed domain gate and the billing-seat
      // pre-check (which must leave no session behind) live here instead.
      resolveUser: async (input, { database }) => {
        const resolution = await resolveSsoSignIn({
          providerId: input.providerId,
          email: input.providerUser.email,
          database: database as unknown as SsoResolutionAdapter,
        });
        if (resolution.action !== "reject") {
          // Carry "is this a newly created account?" to provisionUser, which the
          // plugin does not pass its own `isRegister` to.
          rememberSsoIsNewUser(
            input.providerId,
            input.accountKey.accountId,
            resolution.action === "continue",
          );
        }
        return resolution;
      },
      // Add the signed-in user to the provider's organization through the real
      // member-added path, sync a managed role, and audit the sign-in.
      provisionUser: async ({ user, userInfo, provider }) => {
        const row = provider as unknown as SsoProviderRuntimeRow;
        const organizationId = nonEmptyString(row.organizationId);
        if (!organizationId) {
          // An organization-less provider is never routed to at sign-in; nothing
          // to provision into.
          return;
        }
        const protocol: "oidc" | "saml" = row.samlConfig ? "saml" : "oidc";
        const accountId = nonEmptyString(userInfo.id) ?? "";
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
          isNewUser: takeSsoIsNewUser(row.providerId, accountId),
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
    // Enforces the SourceWeft multi-tenant rules (team-only organizations,
    // private/unique domains, per-organization provider cap, signed SAML
    // assertions) on `/sso/register` and `/sso/update-provider`.
    sourceweftSsoGuard(),
  ];
}
