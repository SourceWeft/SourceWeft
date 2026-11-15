"use client"

import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { AlertCircle, Check, Copy } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import { Label } from "@sourceweft/ui-web/components/ui/label"
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

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

function CopyField({ label, value }: { label: string; value: string }) {
  const { localization } = useAuthPlugin(ssoPlugin)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable; the value is on screen to copy manually.
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
 * Domain-ownership verification for a pending provider: requests a DNS TXT
 * challenge, shows the record to add, and verifies it. A provider cannot be used
 * for sign-in until its domain is verified. The backend's already-localized
 * message is shown on failure (the auth client sends `x-sw-locale`).
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
        setErrorMessage(
          ssoErrorMessage(
            result.error,
            localization.orgRateLimited,
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
  }, [authClient, providerId, coreLocalization, localization.orgRateLimited])

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
      if (result?.error) {
        setErrorMessage(
          ssoErrorMessage(
            result.error,
            localization.orgRateLimited,
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
    <section className="flex flex-col gap-3 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-sm font-medium">
          {localization.orgDomainVerification}
        </h4>
        <p className="text-muted-foreground text-xs">
          {localization.orgDomainVerificationDescription}{" "}
          <span className="font-mono">{domain}</span>
        </p>
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
          <CopyField label={localization.orgTxtRecordHost} value={recordHost} />
          <CopyField label={localization.orgTxtRecordValue} value={token} />
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
