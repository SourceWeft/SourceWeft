"use client"

import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { AlertCircle } from "lucide-react"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

import { CopyableValue } from "./copyable-value"
import { ssoErrorMessage } from "./sso-errors"

/**
 * DNS label prefix the backend's SSO plugin is configured with
 * (`domainVerification.tokenPrefix: "sourceweft-sso"` in
 * `apps/backend/.../sso-plugin.ts`). The verification endpoint returns only the
 * token value, not the record host, so the UI reconstructs the TXT record name
 * `_<prefix>-<providerId>` the plugin resolves against. Keep this in step with
 * the backend `tokenPrefix`.
 */
const TXT_RECORD_PREFIX = "sourceweft-sso"

export type SsoDomainVerificationProps = {
  providerId: string
  domain: string
  /** Called after a successful verification so the caller can refresh the list. */
  onVerified: () => void
}

/**
 * Renders the domain-verification description with the domain inlined at its
 * placeholder, so word order stays correct in every language rather than
 * concatenating the domain onto the end of a sentence.
 */
function DescriptionWithDomain({
  template,
  domain
}: {
  template: string
  domain: string
}) {
  const parts = template.split("{domain}")
  return (
    <p className="text-muted-foreground text-xs">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && (
            <span className="font-mono">{domain}</span>
          )}
        </Fragment>
      ))}
    </p>
  )
}

/**
 * Domain-ownership verification for a pending provider: requests a DNS TXT
 * challenge, shows the record to add, and verifies it. A provider cannot be used
 * for sign-in until its domain is verified. The backend's already-localized
 * message is shown on failure (the auth client sends `x-sw-locale`); the
 * plugin's own English errors are mapped to localized copy by `ssoErrorMessage`.
 * `DOMAIN_VERIFIED` means someone already verified it, so it is treated as
 * success.
 */
export function SsoDomainVerification({
  providerId,
  domain,
  onVerified
}: SsoDomainVerificationProps) {
  const { authClient, localization: coreLocalization } = useAuth<SsoAuthClient>()
  const { localization } = useAuthPlugin(ssoPlugin)

  const [token, setToken] = useState<string | null>(null)
  const [isRequesting, setIsRequesting] = useState(true)
  const [isVerifying, setIsVerifying] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestedRef = useRef(false)

  const requestToken = useCallback(async () => {
    setIsRequesting(true)
    setErrorMessage(null)
    try {
      const result = await authClient.sso.requestDomainVerification({
        providerId
      })
      if (result?.error) {
        // The domain was already verified elsewhere — treat as success.
        if (result.error.code === "DOMAIN_VERIFIED") {
          onVerified()
          return
        }
        setErrorMessage(
          ssoErrorMessage(
            result.error,
            localization,
            coreLocalization.errors.generic
          )
        )
        return
      }
      setToken(result?.data?.domainVerificationToken ?? null)
    } catch {
      setErrorMessage(coreLocalization.errors.generic)
    } finally {
      setIsRequesting(false)
    }
  }, [authClient, providerId, coreLocalization, localization, onVerified])

  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    void requestToken()
  }, [requestToken])

  async function verify() {
    if (isVerifying) return
    setIsVerifying(true)
    setErrorMessage(null)
    try {
      const result = await authClient.sso.verifyDomain({ providerId })
      if (result?.error && result.error.code !== "DOMAIN_VERIFIED") {
        setErrorMessage(
          ssoErrorMessage(
            result.error,
            localization,
            coreLocalization.errors.generic
          )
        )
        return
      }
      toast.success(localization.orgVerifySuccess)
      onVerified()
    } catch {
      setErrorMessage(coreLocalization.errors.generic)
    } finally {
      setIsVerifying(false)
    }
  }

  const recordHost = `_${TXT_RECORD_PREFIX}-${providerId}`

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-sm font-medium">
          {localization.orgDomainVerification}
        </h4>
        <DescriptionWithDomain
          template={localization.orgDomainVerificationDescription}
          domain={domain}
        />
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {isRequesting ? (
        <div className="flex justify-center py-3 text-muted-foreground">
          <Spinner />
        </div>
      ) : token ? (
        <>
          <CopyableValue label={localization.orgTxtRecordHost} value={recordHost} />
          <CopyableValue label={localization.orgTxtRecordValue} value={token} />
          <p className="text-muted-foreground text-xs">
            {localization.orgDnsPropagationNote}
          </p>
          <div>
            <Button type="button" onClick={verify} disabled={isVerifying}>
              {isVerifying && <Spinner data-icon="inline-start" />}
              {isVerifying ? localization.orgVerifying : localization.orgVerify}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  )
}
