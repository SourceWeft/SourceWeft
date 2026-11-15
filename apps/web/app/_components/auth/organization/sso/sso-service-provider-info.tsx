"use client"

import { useAuth, useAuthPlugin } from "@better-auth-ui/react"

import { apiBaseUrl } from "@/lib/api-base-url"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

import { CopyableValue } from "./copyable-value"

/**
 * Builds the service-provider endpoint URLs an identity-provider administrator
 * needs to wire up a connection.
 *
 * `apiBaseUrl` is the backend origin; Better Auth is mounted at `/api/auth`, so
 * the OIDC callback matches the plugin's `redirectURI` (`/sso/callback`) and the
 * SAML ACS/metadata routes match its SAML SP endpoints. The SAML SP entity ID
 * equals the metadata URL: the backend derives the SP entity ID from the
 * provider's registration `issuer`, which this UI sets to that URL.
 */
export function buildServiceProviderUrls(
  providerId: string,
  organizationSlug: string,
  webBaseUrl: string
) {
  const encoded = encodeURIComponent(providerId)
  const metadataUrl = `${apiBaseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${encoded}`
  return {
    oidcRedirectUri: `${apiBaseUrl}/api/auth/sso/callback`,
    samlAcsUrl: `${apiBaseUrl}/api/auth/sso/saml2/sp/acs/${encoded}`,
    samlMetadataUrl: metadataUrl,
    samlEntityId: metadataUrl,
    directSignInLink: `${webBaseUrl}/auth/sso?org=${encodeURIComponent(organizationSlug)}`
  }
}

export type SsoServiceProviderInfoProps = {
  providerId: string
  /** The provider's protocol, so only the relevant endpoints are shown. */
  protocol: "oidc" | "saml"
}

/**
 * Read-only panel of the service-provider endpoints for a provider. Rendered in
 * the create/edit dialog and in each provider's detail area. Only the rows for
 * the provider's protocol are shown, and nothing is shown until a provider ID
 * exists (so no copyable placeholder URLs appear in create mode).
 */
export function SsoServiceProviderInfo({
  providerId,
  protocol
}: SsoServiceProviderInfoProps) {
  const { baseURL } = useAuth()
  const { localization } = useAuthPlugin(ssoPlugin)
  const hasProviderId = providerId.trim().length > 0
  const urls = buildServiceProviderUrls(providerId, "", baseURL)

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-sm font-medium">
          {localization.orgServiceProviderInfo}
        </h4>
        <p className="text-muted-foreground text-xs">
          {localization.orgServiceProviderDescription}
        </p>
      </div>
      {hasProviderId ? (
        <div className="flex min-w-0 flex-col gap-3">
          {protocol === "oidc" ? (
            <CopyableValue
              label={localization.orgOidcRedirectUri}
              value={urls.oidcRedirectUri}
            />
          ) : (
            <>
              <CopyableValue
                label={localization.orgSamlAcsUrl}
                value={urls.samlAcsUrl}
              />
              <CopyableValue
                label={localization.orgSamlMetadataUrl}
                value={urls.samlMetadataUrl}
              />
              <CopyableValue
                label={localization.orgSamlEntityId}
                value={urls.samlEntityId}
              />
            </>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {localization.orgServiceProviderPending}
        </p>
      )}
    </section>
  )
}
