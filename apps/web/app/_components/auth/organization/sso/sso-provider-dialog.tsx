"use client"

import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { AlertCircle } from "lucide-react"
import { type FormEvent, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@sourceweft/ui-web/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel
} from "@sourceweft/ui-web/components/ui/field"
import { Input } from "@sourceweft/ui-web/components/ui/input"
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner"
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea"
import { apiBaseUrl } from "@/lib/api-base-url"
import { ssoPlugin } from "@/lib/auth/sso-plugin"
import { cn } from "@sourceweft/ui-web/lib/utils"

import { SsoServiceProviderInfo } from "./sso-service-provider-info"

/** Matches the backend plugin's `saml.maxMetadataSize` default (100 KiB). */
const MAX_METADATA_BYTES = 100 * 1024
const PROVIDER_ID_PATTERN = /^[a-z0-9-]{3,64}$/
const DEFAULT_SCOPES = "openid email profile"

type Protocol = "oidc" | "saml"

/** A sanitized provider from `authClient.sso.providers()` / `getProvider`. */
export type SsoProviderSummary = {
  providerId: string
  type: string
  issuer: string
  domain: string
  domainVerified: boolean
  oidcConfig?: { clientIdLastFour?: string; scopes?: string[] } | null
  samlConfig?: { entryPoint?: string } | null
  roleAttribute?: string | null
  adminRoleValue?: string | null
}

export type SsoProviderDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string
  organizationSlug: string
  /** When set the dialog edits this provider; otherwise it registers a new one. */
  provider?: SsoProviderSummary
  /** Called after a successful register/update so the caller can refresh. */
  onSaved: () => void
}

/** Derive a stable providerId suggestion from the domain and protocol. */
export function suggestProviderId(domain: string, protocol: Protocol) {
  const slug = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug ? `${slug}-${protocol}` : ""
}

function parseScopes(value: string) {
  return value.trim().split(/\s+/).filter(Boolean)
}

/** A PEM certificate block, or a bare base64 body. */
function looksLikeCertificate(value: string) {
  const trimmed = value.trim()
  if (/-----BEGIN CERTIFICATE-----/.test(trimmed)) return true
  return trimmed.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

/**
 * Create/edit dialog for an SSO identity provider. Hosts an OIDC and a SAML
 * form; the backend derives OIDC discovery from the issuer and extracts SAML
 * details from pasted metadata, so neither form exposes per-endpoint inputs or
 * a fetch-by-URL control. Secrets are never prefilled: on edit, a blank secret
 * or client id means "leave unchanged". The backend's already-localized error
 * message is surfaced (domain errors under the domain field).
 */
export function SsoProviderDialog({
  open,
  onOpenChange,
  organizationId,
  organizationSlug,
  provider,
  onSaved
}: SsoProviderDialogProps) {
  const { authClient, localization: coreLocalization } = useAuth<SsoAuthClient>()
  const { localization } = useAuthPlugin(ssoPlugin)
  const isEdit = Boolean(provider)

  const [protocol, setProtocol] = useState<Protocol>(
    (provider?.type as Protocol) ?? "oidc"
  )
  const [providerId, setProviderId] = useState(provider?.providerId ?? "")
  const [domain, setDomain] = useState(provider?.domain ?? "")
  const [issuer, setIssuer] = useState(
    provider?.type === "oidc" ? (provider?.issuer ?? "") : ""
  )
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [scopes, setScopes] = useState(
    provider?.oidcConfig?.scopes?.join(" ") ?? DEFAULT_SCOPES
  )
  const [entryPoint, setEntryPoint] = useState(
    provider?.samlConfig?.entryPoint ?? ""
  )
  const [cert, setCert] = useState("")
  const [idpEntityId, setIdpEntityId] = useState("")
  const [metadata, setMetadata] = useState("")
  const [roleAttribute, setRoleAttribute] = useState(
    provider?.roleAttribute ?? ""
  )
  const [adminRoleValue, setAdminRoleValue] = useState(
    provider?.adminRoleValue ?? ""
  )

  const providerIdTouched = useRef(isEdit)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Keep the providerId in step with the domain/protocol until the admin edits
  // it by hand; never on an existing provider (its id is immutable).
  function syncProviderId(nextDomain: string, nextProtocol: Protocol) {
    if (isEdit || providerIdTouched.current) return
    setProviderId(suggestProviderId(nextDomain, nextProtocol))
  }

  const samlEntityId = useMemo(
    () =>
      `${apiBaseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(
        providerId || "provider"
      )}`,
    [providerId]
  )

  function validate(): {
    errors: Record<string, string>
    formLevel: string | null
  } {
    const errors: Record<string, string> = {}
    let formLevel: string | null = null

    if (!isEdit) {
      if (!PROVIDER_ID_PATTERN.test(providerId)) {
        errors.providerId = localization.orgProviderIdInvalid
      }
    }
    if (!domain.trim()) errors.domain = localization.orgFieldRequired

    if (protocol === "oidc") {
      if (!issuer.trim()) errors.issuer = localization.orgFieldRequired
      if (!isEdit) {
        if (!clientId.trim()) errors.clientId = localization.orgFieldRequired
        if (!clientSecret.trim()) {
          errors.clientSecret = localization.orgFieldRequired
        }
      }
    } else {
      const hasMetadata = metadata.trim().length > 0
      if (hasMetadata) {
        if (byteLength(metadata) > MAX_METADATA_BYTES) {
          errors.metadata = localization.orgMetadataTooLarge
        }
      } else if (
        !entryPoint.trim() &&
        !cert.trim() &&
        !idpEntityId.trim() &&
        !isEdit
      ) {
        formLevel = localization.orgSamlNeedsConfig
      } else if (!isEdit) {
        if (!entryPoint.trim()) errors.entryPoint = localization.orgFieldRequired
        if (!cert.trim()) {
          errors.cert = localization.orgFieldRequired
        } else if (!looksLikeCertificate(cert)) {
          errors.cert = localization.orgCertificateInvalid
        }
        if (!idpEntityId.trim()) {
          errors.idpEntityId = localization.orgFieldRequired
        }
      } else {
        if (cert.trim() && !looksLikeCertificate(cert)) {
          errors.cert = localization.orgCertificateInvalid
        }
      }
    }

    return { errors, formLevel }
  }

  function buildBody(): Record<string, unknown> {
    const trimmedRole = roleAttribute.trim()
    const trimmedAdmin = adminRoleValue.trim()

    if (!isEdit) {
      const body: Record<string, unknown> = {
        providerId: providerId.trim(),
        domain: domain.trim(),
        organizationId
      }
      if (trimmedRole) body.roleAttribute = trimmedRole
      if (trimmedAdmin) body.adminRoleValue = trimmedAdmin

      if (protocol === "oidc") {
        body.issuer = issuer.trim()
        body.oidcConfig = {
          clientId: clientId.trim(),
          clientSecret,
          scopes: parseScopes(scopes)
        }
      } else {
        body.issuer = samlEntityId
        body.samlConfig = metadata.trim()
          ? { idpMetadata: { metadata }, wantAssertionsSigned: true }
          : {
              entryPoint: entryPoint.trim(),
              cert: cert.trim(),
              idpMetadata: { entityID: idpEntityId.trim() },
              wantAssertionsSigned: true
            }
      }
      return body
    }

    // Update: send only the fields the admin actually changed. A blank secret or
    // client id is "unchanged" and is omitted entirely.
    const body: Record<string, unknown> = {
      providerId: provider?.providerId
    }
    if (domain.trim() !== provider?.domain) body.domain = domain.trim()

    if (protocol === "oidc") {
      if (issuer.trim() !== provider?.issuer) body.issuer = issuer.trim()
      const oidcConfig: Record<string, unknown> = {}
      if (clientId.trim()) oidcConfig.clientId = clientId.trim()
      if (clientSecret) oidcConfig.clientSecret = clientSecret
      const nextScopes = parseScopes(scopes)
      if (nextScopes.join(" ") !== (provider?.oidcConfig?.scopes ?? []).join(" ")) {
        oidcConfig.scopes = nextScopes
      }
      if (Object.keys(oidcConfig).length > 0) body.oidcConfig = oidcConfig
    } else {
      const samlConfig: Record<string, unknown> = {}
      if (entryPoint.trim() && entryPoint.trim() !== provider?.samlConfig?.entryPoint) {
        samlConfig.entryPoint = entryPoint.trim()
      }
      if (cert.trim()) samlConfig.cert = cert.trim()
      if (metadata.trim()) {
        samlConfig.idpMetadata = { metadata }
      } else if (idpEntityId.trim()) {
        samlConfig.idpMetadata = { entityID: idpEntityId.trim() }
      }
      if (Object.keys(samlConfig).length > 0) body.samlConfig = samlConfig
    }

    if (trimmedRole !== (provider?.roleAttribute ?? "")) {
      body.roleAttribute = trimmedRole
    }
    if (trimmedAdmin !== (provider?.adminRoleValue ?? "")) {
      body.adminRoleValue = trimmedAdmin
    }
    return body
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return

    const { errors, formLevel } = validate()
    setFieldErrors(errors)
    setFormError(formLevel)
    if (Object.keys(errors).length > 0 || formLevel) return

    setIsSubmitting(true)
    try {
      const body = buildBody()
      const result = isEdit
        ? await authClient.sso.updateProvider(body)
        : await authClient.sso.register(body)

      if (result?.error) {
        const message = result.error.message || coreLocalization.errors.generic
        if (result.error.code === "SSO_DOMAIN_NOT_ALLOWED") {
          setFieldErrors((current) => ({ ...current, domain: message }))
        } else {
          setFormError(message)
        }
        return
      }

      toast.success(
        isEdit ? localization.orgUpdateSuccess : localization.orgCreateSuccess
      )
      onSaved()
      onOpenChange(false)
    } catch {
      setFormError(coreLocalization.errors.generic)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? localization.orgEditTitle : localization.orgCreateTitle}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? localization.orgEditDescription
              : localization.orgCreateDescription}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5 pt-4">
          {formError && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          {!isEdit && (
            <div
              role="tablist"
              aria-label={localization.orgProtocol}
              className="grid grid-cols-2 gap-2"
            >
              {(["oidc", "saml"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={protocol === value}
                  variant={protocol === value ? "default" : "outline"}
                  onClick={() => {
                    setProtocol(value)
                    syncProviderId(domain, value)
                  }}
                >
                  {value === "oidc"
                    ? localization.orgProtocolOidc
                    : localization.orgProtocolSaml}
                </Button>
              ))}
            </div>
          )}

          <Field data-invalid={Boolean(fieldErrors.domain)}>
            <FieldLabel htmlFor="sso-domain">{localization.orgDomain}</FieldLabel>
            <Input
              id="sso-domain"
              value={domain}
              aria-invalid={Boolean(fieldErrors.domain)}
              onChange={(event) => {
                setDomain(event.target.value)
                syncProviderId(event.target.value, protocol)
              }}
            />
            {isEdit && (
              <FieldDescription>
                {localization.orgDomainChangeWarning}
              </FieldDescription>
            )}
            {fieldErrors.domain && <FieldError errors={[{ message: fieldErrors.domain }]} />}
          </Field>

          <Field data-invalid={Boolean(fieldErrors.providerId)}>
            <FieldLabel htmlFor="sso-provider-id">
              {localization.orgProviderId}
            </FieldLabel>
            <Input
              id="sso-provider-id"
              value={providerId}
              disabled={isEdit}
              aria-invalid={Boolean(fieldErrors.providerId)}
              onChange={(event) => {
                providerIdTouched.current = true
                setProviderId(event.target.value)
              }}
            />
            <FieldDescription>
              {isEdit
                ? localization.orgProviderIdImmutableHint
                : localization.orgProviderIdHint}
            </FieldDescription>
            {fieldErrors.providerId && (
              <FieldError errors={[{ message: fieldErrors.providerId }]} />
            )}
          </Field>

          {protocol === "oidc" ? (
            <>
              <Field data-invalid={Boolean(fieldErrors.issuer)}>
                <FieldLabel htmlFor="sso-issuer">
                  {localization.orgIssuer}
                </FieldLabel>
                <Input
                  id="sso-issuer"
                  value={issuer}
                  placeholder="https://idp.example.com"
                  aria-invalid={Boolean(fieldErrors.issuer)}
                  onChange={(event) => setIssuer(event.target.value)}
                />
                <FieldDescription>{localization.orgIssuerHint}</FieldDescription>
                {fieldErrors.issuer && (
                  <FieldError errors={[{ message: fieldErrors.issuer }]} />
                )}
              </Field>

              <Field data-invalid={Boolean(fieldErrors.clientId)}>
                <FieldLabel htmlFor="sso-client-id">
                  {localization.orgClientId}
                </FieldLabel>
                <Input
                  id="sso-client-id"
                  value={clientId}
                  autoComplete="off"
                  placeholder={
                    isEdit && provider?.oidcConfig?.clientIdLastFour
                      ? `•••• ${provider.oidcConfig.clientIdLastFour}`
                      : undefined
                  }
                  aria-invalid={Boolean(fieldErrors.clientId)}
                  onChange={(event) => setClientId(event.target.value)}
                />
                {isEdit && (
                  <FieldDescription>
                    {localization.orgClientIdKeepHint}
                  </FieldDescription>
                )}
                {fieldErrors.clientId && (
                  <FieldError errors={[{ message: fieldErrors.clientId }]} />
                )}
              </Field>

              <Field data-invalid={Boolean(fieldErrors.clientSecret)}>
                <FieldLabel htmlFor="sso-client-secret">
                  {localization.orgClientSecret}
                </FieldLabel>
                <Input
                  id="sso-client-secret"
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  aria-invalid={Boolean(fieldErrors.clientSecret)}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
                {isEdit && (
                  <FieldDescription>
                    {localization.orgClientSecretKeepHint}
                  </FieldDescription>
                )}
                {fieldErrors.clientSecret && (
                  <FieldError errors={[{ message: fieldErrors.clientSecret }]} />
                )}
              </Field>

              <Field>
                <FieldLabel htmlFor="sso-scopes">
                  {localization.orgScopes}
                </FieldLabel>
                <Input
                  id="sso-scopes"
                  value={scopes}
                  onChange={(event) => setScopes(event.target.value)}
                />
                <FieldDescription>{localization.orgScopesHint}</FieldDescription>
              </Field>
            </>
          ) : (
            <>
              <FieldDescription>{localization.orgSamlConfigHint}</FieldDescription>

              <Field data-invalid={Boolean(fieldErrors.entryPoint)}>
                <FieldLabel htmlFor="sso-entry-point">
                  {localization.orgEntryPoint}
                </FieldLabel>
                <Input
                  id="sso-entry-point"
                  value={entryPoint}
                  placeholder="https://idp.example.com/sso"
                  aria-invalid={Boolean(fieldErrors.entryPoint)}
                  onChange={(event) => setEntryPoint(event.target.value)}
                />
                {fieldErrors.entryPoint && (
                  <FieldError errors={[{ message: fieldErrors.entryPoint }]} />
                )}
              </Field>

              <Field data-invalid={Boolean(fieldErrors.idpEntityId)}>
                <FieldLabel htmlFor="sso-idp-entity-id">
                  {localization.orgIdpEntityId}
                </FieldLabel>
                <Input
                  id="sso-idp-entity-id"
                  value={idpEntityId}
                  aria-invalid={Boolean(fieldErrors.idpEntityId)}
                  onChange={(event) => setIdpEntityId(event.target.value)}
                />
                {fieldErrors.idpEntityId && (
                  <FieldError errors={[{ message: fieldErrors.idpEntityId }]} />
                )}
              </Field>

              <Field data-invalid={Boolean(fieldErrors.cert)}>
                <FieldLabel htmlFor="sso-cert">
                  {localization.orgCertificate}
                </FieldLabel>
                <Textarea
                  id="sso-cert"
                  rows={4}
                  value={cert}
                  className="font-mono text-xs"
                  aria-invalid={Boolean(fieldErrors.cert)}
                  onChange={(event) => setCert(event.target.value)}
                />
                <FieldDescription>
                  {localization.orgCertificateHint}
                </FieldDescription>
                {fieldErrors.cert && <FieldError errors={[{ message: fieldErrors.cert }]} />}
              </Field>

              <Field data-invalid={Boolean(fieldErrors.metadata)}>
                <FieldLabel htmlFor="sso-metadata">
                  {localization.orgSamlMetadata}
                </FieldLabel>
                <Textarea
                  id="sso-metadata"
                  rows={4}
                  value={metadata}
                  className="font-mono text-xs"
                  aria-invalid={Boolean(fieldErrors.metadata)}
                  onChange={(event) => setMetadata(event.target.value)}
                />
                <FieldDescription>
                  {localization.orgSamlMetadataHint}
                </FieldDescription>
                {fieldErrors.metadata && (
                  <FieldError errors={[{ message: fieldErrors.metadata }]} />
                )}
              </Field>
            </>
          )}

          <Field>
            <FieldLabel htmlFor="sso-role-attribute">
              {localization.orgRoleAttribute}
            </FieldLabel>
            <Input
              id="sso-role-attribute"
              value={roleAttribute}
              onChange={(event) => setRoleAttribute(event.target.value)}
            />
            <FieldDescription>
              {localization.orgRoleAttributeHint}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="sso-admin-role-value">
              {localization.orgAdminRoleValue}
            </FieldLabel>
            <Input
              id="sso-admin-role-value"
              value={adminRoleValue}
              onChange={(event) => setAdminRoleValue(event.target.value)}
            />
            <FieldDescription>
              {localization.orgAdminRoleValueHint}
            </FieldDescription>
          </Field>

          <SsoServiceProviderInfo
            providerId={providerId}
            organizationSlug={organizationSlug}
          />

          <DialogFooter className={cn("pt-2")}>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {localization.orgCancel}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Spinner data-icon="inline-start" />}
              {localization.orgSave}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
