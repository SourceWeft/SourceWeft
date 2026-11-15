"use client"

import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { Check, Copy } from "lucide-react"
import { useState } from "react"

import { Button } from "@sourceweft/ui-web/components/ui/button"
import { Label } from "@sourceweft/ui-web/components/ui/label"
import { apiBaseUrl } from "@/lib/api-base-url"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

/**
 * Builds the service-provider endpoint URLs an identity-provider administrator
 * needs to wire up a connection. OIDC and SAML are both shown because the same
 * SourceWeft SP serves either protocol for a given provider — the admin uses
 * the lines that match their IdP.
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
  organizationSlug: string
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  const { localization } = useAuthPlugin(ssoPlugin)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be blocked; the value stays visible to copy by hand.
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded border bg-background px-2 py-1.5 font-mono text-xs whitespace-nowrap">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={copy}
          aria-label={copied ? localization.orgCopied : localization.orgCopy}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}

/**
 * Read-only panel of the service-provider endpoints for a provider. Rendered in
 * the create/edit dialog and in each provider's detail area.
 */
export function SsoServiceProviderInfo({
  providerId,
  organizationSlug
}: SsoServiceProviderInfoProps) {
  const { baseURL } = useAuth()
  const { localization } = useAuthPlugin(ssoPlugin)
  const urls = buildServiceProviderUrls(
    providerId || "<provider-id>",
    organizationSlug,
    baseURL
  )

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-sm font-medium">
          {localization.orgServiceProviderInfo}
        </h4>
        <p className="text-muted-foreground text-xs">
          {localization.orgServiceProviderDescription}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <CopyableValue
          label={localization.orgOidcRedirectUri}
          value={urls.oidcRedirectUri}
        />
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
        <CopyableValue
          label={localization.orgDirectSignInLink}
          value={urls.directSignInLink}
        />
      </div>
    </section>
  )
}
