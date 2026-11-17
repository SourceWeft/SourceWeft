"use client"

import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { AlertCircle } from "lucide-react"
import { type FormEvent, useRef, useState } from "react"
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
import { ssoPlugin } from "@/lib/auth/sso-plugin"

import { parseIdpMetadata } from "./parse-idp-metadata"
import {
  SSO_DISCOVERY_CODES,
  ssoErrorMessage,
  type SsoClientError
} from "./sso-errors"
import {
  SsoServiceProviderInfo,
  buildServiceProviderUrls
} from "./sso-service-provider-info"

const PROVIDER_ID_PATTERN = /^[a-z0-9-]{3,47}$/
/** Longest providerId the DNS TXT label (`_sourceweft-sso-<id>`) stays ≤ 63. */
const MAX_PROVIDER_ID_LENGTH = 47
const DEFAULT_SCOPES = "openid email profile"

type Protocol = "oidc" | "saml"

/** A sanitized provider from `authClient.sso.providers()` / `getProvider`. */
export type SsoProviderSummary = {
  providerId: string
  type: string
  issuer: string
  domain: string
  organizationId?: string | null
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
  /** When set the dialog edits this provider; otherwise it registers a new one. */
  provider?: SsoProviderSummary
  /** Called after a successful register/update so the caller can refresh. */
  onSaved: () => void
}

/**
 * Derive a stable providerId suggestion from the domain and protocol. The
 * domain part is truncated so the final id never exceeds the DNS limit
 * (`MAX_PROVIDER_ID_LENGTH`), keeping the protocol suffix and dropping any
 * trailing hyphen left by truncation.
 */
export function suggestProviderId(domain: string, protocol: Protocol) {
  const suffix = `-${protocol}`
  const maxSlug = MAX_PROVIDER_ID_LENGTH - suffix.length
  let slug = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug) return ""
  if (slug.length > maxSlug) {
    slug = slug.slice(0, maxSlug).replace(/-+$/g, "")
  }
  return slug ? `${slug}${suffix}` : ""
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

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Create/edit dialog for an SSO identity provider. Hosts an OIDC and a SAML
 * form in a tab each; the backend derives OIDC discovery from the issuer.
 *
 * SAML registration always submits explicit fields — IdP sign-on URL, signing
 * certificate and IdP entity ID — which the admin can enter by hand or fill by
 * pasting IdP metadata XML (parsed in the browser, never uploaded or stored).
 * We deliberately do NOT send the raw metadata: the plugin ignores entryPoint
 * and cert when `idpMetadata.metadata` is present, which would silently discard
 * any edits the admin made to the parsed values. Secrets are never prefilled: on
 * edit, a blank secret/client id/cert means "leave unchanged".
 *
 * Identity fields (issuer, OIDC client id, SAML sign-on URL / certificate /
 * entity ID) cannot be changed once a member has signed in; editing them then
 * fails with a 409 the dialog surfaces at form level while staying open. Plugin
 * errors are English, so they are mapped to localized copy and routed to the
 * relevant field (domain, provider id, issuer).
 */
export function SsoProviderDialog({
  open,
  onOpenChange,
  organizationId,
  provider,
  onSaved
}: SsoProviderDialogProps) {
  const { authClient, localization: coreLocalization } = useAuth<SsoAuthClient>()
  const { localization } = useAuthPlugin(ssoPlugin)
  const isEdit = Boolean(provider)
  const generic = coreLocalization.errors.generic

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
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [metadataNotices, setMetadataNotices] = useState<string[]>([])
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

  // Paste-to-fill: parse the IdP metadata XML in the browser and populate the
  // explicit SAML fields. Nothing is submitted from here — the admin reviews and
  // edits the filled values, which are what registration sends.
  function handleMetadataChange(value: string) {
    setMetadata(value)
    if (!value.trim()) {
      setMetadataError(null)
      setMetadataNotices([])
      return
    }
    const result = parseIdpMetadata(value)
    if (!result.ok) {
      setMetadataNotices([])
      setMetadataError(
        result.reason === "too-large"
          ? localization.orgMetadataTooLarge
          : localization.orgMetadataParseError
      )
      return
    }
    setMetadataError(null)

    // A value that was read fills its field and clears its message; a value that
    // could not be read gets a message on its own field (not just under the
    // metadata box) and is left for manual entry.
    const nextFieldErrors: Record<string, string> = {}
    if (result.value.entryPoint) {
      setEntryPoint(result.value.entryPoint)
      nextFieldErrors.entryPoint = ""
    } else {
      nextFieldErrors.entryPoint = localization.orgMetadataNoEntryPoint
    }
    if (result.value.entityId) {
      setIdpEntityId(result.value.entityId)
      nextFieldErrors.idpEntityId = ""
    } else {
      nextFieldErrors.idpEntityId = localization.orgMetadataNoEntityId
    }
    if (result.value.signingCert) {
      setCert(result.value.signingCert)
      nextFieldErrors.cert = ""
    } else {
      nextFieldErrors.cert = localization.orgMetadataNoCert
    }
    setFieldErrors((current) => ({ ...current, ...nextFieldErrors }))

    // The multiple-certificate advisory stays by the metadata box.
    setMetadataNotices(
      result.value.multipleSigningCerts
        ? [localization.orgMetadataMultipleCerts]
        : []
    )
  }

  function validate(): {
    errors: Record<string, string>
    formLevel: string | null
  } {
    const errors: Record<string, string> = {}
    let formLevel: string | null = null

    if (!isEdit && !PROVIDER_ID_PATTERN.test(providerId)) {
      errors.providerId = localization.orgProviderIdInvalid
    }
    if (!domain.trim()) errors.domain = localization.orgFieldRequired

    if (protocol === "oidc") {
      if (!issuer.trim()) {
        errors.issuer = localization.orgFieldRequired
      } else if (!isHttpUrl(issuer.trim())) {
        errors.issuer = localization.orgIssuerInvalid
      }
      if (!isEdit) {
        if (!clientId.trim()) errors.clientId = localization.orgFieldRequired
        if (!clientSecret.trim()) {
          errors.clientSecret = localization.orgFieldRequired
        }
      }
    } else {
      const entry = entryPoint.trim()
      const certVal = cert.trim()
      const entity = idpEntityId.trim()
      if (!isEdit && !entry && !certVal && !entity) {
        // Create with nothing provided — one clear prompt instead of three.
        formLevel = localization.orgSamlNeedsConfig
      } else {
        // One rule set for both modes: on create all three explicit fields are
        // required; on edit a blank field keeps the stored value (the backend
        // never returns cert/entity ID), so only the values the admin actually
        // provided are validated and sent. A present entryPoint must be a valid
        // URL in either mode.
        if (!entry) {
          if (!isEdit) errors.entryPoint = localization.orgFieldRequired
        } else if (!isHttpUrl(entry)) {
          errors.entryPoint = localization.orgEntryPointInvalid
        }
        if (!certVal) {
          if (!isEdit) errors.cert = localization.orgFieldRequired
        } else if (!looksLikeCertificate(certVal)) {
          errors.cert = localization.orgCertificateInvalid
        }
        if (!entity && !isEdit) {
          errors.idpEntityId = localization.orgFieldRequired
        }
      }
    }

    // Role mapping must be both filled or both empty; flag whichever is empty.
    const hasRole = Boolean(roleAttribute.trim())
    const hasAdmin = Boolean(adminRoleValue.trim())
    if (hasRole !== hasAdmin) {
      if (!hasRole) errors.roleAttribute = localization.orgRoleMappingIncomplete
      if (!hasAdmin) {
        errors.adminRoleValue = localization.orgRoleMappingIncomplete
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
        body.issuer = buildServiceProviderUrls(providerId.trim(), "", "").samlEntityId
        body.samlConfig = {
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
      if (
        entryPoint.trim() &&
        entryPoint.trim() !== provider?.samlConfig?.entryPoint
      ) {
        samlConfig.entryPoint = entryPoint.trim()
      }
      if (cert.trim()) samlConfig.cert = cert.trim()
      if (idpEntityId.trim()) {
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

  // Map a plugin/backend error onto the dialog: a localized field message where
  // the cause points at one field, otherwise a form-level message. The dialog
  // stays open and keeps the admin's input in every error case.
  function showMutationError(error: NonNullable<SsoClientError>) {
    if (error.status === 429) {
      setFormError(localization.orgRateLimited)
      return
    }
    const code = error.code ?? ""
    const message = error.message ?? ""
    const routeField = (field: string, value: string) =>
      setFieldErrors((current) => ({ ...current, [field]: value }))

    if (code === "SSO_DOMAIN_NOT_ALLOWED") {
      routeField("domain", message || generic)
      return
    }
    if (code === "SSO_INVALID_PROVIDER_ID") {
      routeField("providerId", message || localization.orgProviderIdInvalid)
      return
    }
    if (SSO_DISCOVERY_CODES.has(code)) {
      routeField("issuer", localization.orgIssuerUnreachable)
      return
    }
    if (code === "SSO_PROVIDER_IDENTITY_LOCKED") {
      setFormError(message || localization.orgIdentityLocked)
      return
    }
    // Plugin-native (uncoded, English) errors matched by message.
    if (/already exists/i.test(message)) {
      routeField("providerId", localization.orgProviderIdTaken)
      return
    }
    if (/reserved/i.test(message)) {
      routeField("providerId", localization.orgProviderIdReserved)
      return
    }
    if (error.status === 409 && /identity fields/i.test(message)) {
      setFormError(localization.orgIdentityLocked)
      return
    }
    setFormError(ssoErrorMessage(error, localization, generic))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return

    const { errors, formLevel } = validate()
    setFieldErrors(errors)
    setFormError(formLevel)
    if (Object.keys(errors).length > 0 || formLevel) return

    const body = buildBody()
    // An edit that changed nothing closes the dialog without a request (the
    // plugin would otherwise reject an empty update).
    if (isEdit) {
      const changed = Object.keys(body).filter((key) => key !== "providerId")
      if (changed.length === 0) {
        onOpenChange(false)
        return
      }
    }

    setIsSubmitting(true)
    try {
      const result = isEdit
        ? await authClient.sso.updateProvider(body)
        : await authClient.sso.register(body)

      if (result?.error) {
        showMutationError(result.error)
        return
      }

      toast.success(
        isEdit ? localization.orgUpdateSuccess : localization.orgCreateSuccess
      )
      onSaved()
      onOpenChange(false)
    } catch {
      setFormError(generic)
    } finally {
      setIsSubmitting(false)
    }
  }

  const describedBy = (field: string) =>
    fieldErrors[field] ? `sso-${field}-error` : undefined

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

          <Field data-invalid={Boolean(fieldErrors.domain)}>
            <FieldLabel htmlFor="sso-domain">{localization.orgDomain}</FieldLabel>
            <Input
              id="sso-domain"
              value={domain}
              aria-invalid={Boolean(fieldErrors.domain)}
              aria-describedby={describedBy("domain")}
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
            {fieldErrors.domain && (
              <FieldError
                id="sso-domain-error"
                errors={[{ message: fieldErrors.domain }]}
              />
            )}
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
              aria-describedby={describedBy("providerId")}
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
              <FieldError
                id="sso-providerId-error"
                errors={[{ message: fieldErrors.providerId }]}
              />
            )}
          </Field>

          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium" id="sso-protocol-label">
              {localization.orgProtocol}
            </span>
            {isEdit ? (
              <p className="text-sm" aria-labelledby="sso-protocol-label">
                {protocol === "oidc"
                  ? localization.orgProtocolOidc
                  : localization.orgProtocolSaml}
              </p>
            ) : (
              <div
                role="tablist"
                aria-labelledby="sso-protocol-label"
                className="grid grid-cols-2 gap-2"
              >
                {(["oidc", "saml"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    role="tab"
                    id={`sso-tab-${value}`}
                    aria-selected={protocol === value}
                    aria-controls={`sso-panel-${value}`}
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

            {protocol === "oidc" ? (
              <div
                role="tabpanel"
                id="sso-panel-oidc"
                aria-labelledby="sso-tab-oidc"
                className="flex flex-col gap-5"
              >
                {isEdit && (
                  <p className="text-muted-foreground text-xs">
                    {localization.orgIdentityLockedHint}
                  </p>
                )}
                <Field data-invalid={Boolean(fieldErrors.issuer)}>
                  <FieldLabel htmlFor="sso-issuer">
                    {localization.orgIssuer}
                  </FieldLabel>
                  <Input
                    id="sso-issuer"
                    value={issuer}
                    placeholder="https://idp.example.com"
                    aria-invalid={Boolean(fieldErrors.issuer)}
                    aria-describedby={describedBy("issuer")}
                    onChange={(event) => setIssuer(event.target.value)}
                  />
                  <FieldDescription>{localization.orgIssuerHint}</FieldDescription>
                  {fieldErrors.issuer && (
                    <FieldError
                      id="sso-issuer-error"
                      errors={[{ message: fieldErrors.issuer }]}
                    />
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
                    aria-describedby={describedBy("clientId")}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                  {isEdit && (
                    <FieldDescription>
                      {localization.orgClientIdKeepHint}
                    </FieldDescription>
                  )}
                  {fieldErrors.clientId && (
                    <FieldError
                      id="sso-clientId-error"
                      errors={[{ message: fieldErrors.clientId }]}
                    />
                  )}
                </Field>

                <Field data-invalid={Boolean(fieldErrors.clientSecret)}>
                  <FieldLabel htmlFor="sso-client-secret">
                    {localization.orgClientSecret}
                  </FieldLabel>
                  <Input
                    id="sso-client-secret"
                    type="password"
                    autoComplete="new-password"
                    value={clientSecret}
                    aria-invalid={Boolean(fieldErrors.clientSecret)}
                    aria-describedby={describedBy("clientSecret")}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                  {isEdit && (
                    <FieldDescription>
                      {localization.orgClientSecretKeepHint}
                    </FieldDescription>
                  )}
                  {fieldErrors.clientSecret && (
                    <FieldError
                      id="sso-clientSecret-error"
                      errors={[{ message: fieldErrors.clientSecret }]}
                    />
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
                  <FieldDescription>
                    {localization.orgScopesHint}
                  </FieldDescription>
                </Field>
              </div>
            ) : (
              <div
                role="tabpanel"
                id="sso-panel-saml"
                aria-labelledby="sso-tab-saml"
                className="flex flex-col gap-5"
              >
                {isEdit && (
                  <p className="text-muted-foreground text-xs">
                    {localization.orgIdentityLockedHint}
                  </p>
                )}
                <FieldDescription>
                  {localization.orgSamlConfigHint}
                </FieldDescription>

                <Field data-invalid={Boolean(fieldErrors.entryPoint)}>
                  <FieldLabel htmlFor="sso-entry-point">
                    {localization.orgEntryPoint}
                  </FieldLabel>
                  <Input
                    id="sso-entry-point"
                    value={entryPoint}
                    placeholder="https://idp.example.com/sso"
                    aria-invalid={Boolean(fieldErrors.entryPoint)}
                    aria-describedby={describedBy("entryPoint")}
                    onChange={(event) => setEntryPoint(event.target.value)}
                  />
                  {fieldErrors.entryPoint && (
                    <FieldError
                      id="sso-entryPoint-error"
                      errors={[{ message: fieldErrors.entryPoint }]}
                    />
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
                    aria-describedby={describedBy("idpEntityId")}
                    onChange={(event) => setIdpEntityId(event.target.value)}
                  />
                  {isEdit && (
                    <FieldDescription>
                      {localization.orgSamlKeepHint}
                    </FieldDescription>
                  )}
                  {fieldErrors.idpEntityId && (
                    <FieldError
                      id="sso-idpEntityId-error"
                      errors={[{ message: fieldErrors.idpEntityId }]}
                    />
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
                    aria-describedby={describedBy("cert")}
                    onChange={(event) => setCert(event.target.value)}
                  />
                  <FieldDescription>
                    {isEdit
                      ? localization.orgSamlKeepHint
                      : localization.orgCertificateHint}
                  </FieldDescription>
                  {fieldErrors.cert && (
                    <FieldError
                      id="sso-cert-error"
                      errors={[{ message: fieldErrors.cert }]}
                    />
                  )}
                </Field>

                <Field data-invalid={Boolean(metadataError)}>
                  <FieldLabel htmlFor="sso-metadata">
                    {localization.orgSamlMetadata}
                  </FieldLabel>
                  <Textarea
                    id="sso-metadata"
                    rows={4}
                    value={metadata}
                    className="font-mono text-xs"
                    aria-invalid={Boolean(metadataError)}
                    onChange={(event) => handleMetadataChange(event.target.value)}
                  />
                  <FieldDescription>
                    {localization.orgSamlMetadataHint}
                  </FieldDescription>
                  {metadataError && (
                    <FieldError errors={[{ message: metadataError }]} />
                  )}
                  {metadataNotices.map((notice) => (
                    <p
                      key={notice}
                      className="text-xs text-muted-foreground"
                    >
                      {notice}
                    </p>
                  ))}
                </Field>

                <Alert>
                  <AlertCircle />
                  <AlertDescription>
                    {localization.orgSamlSecurityNote}
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </div>

          <Field data-invalid={Boolean(fieldErrors.roleAttribute)}>
            <FieldLabel htmlFor="sso-role-attribute">
              {localization.orgRoleAttribute}
            </FieldLabel>
            <Input
              id="sso-role-attribute"
              value={roleAttribute}
              aria-invalid={Boolean(fieldErrors.roleAttribute)}
              aria-describedby={describedBy("roleAttribute")}
              onChange={(event) => setRoleAttribute(event.target.value)}
            />
            <FieldDescription>
              {localization.orgRoleAttributeHint}
            </FieldDescription>
            {fieldErrors.roleAttribute && (
              <FieldError
                id="sso-roleAttribute-error"
                errors={[{ message: fieldErrors.roleAttribute }]}
              />
            )}
          </Field>

          <Field data-invalid={Boolean(fieldErrors.adminRoleValue)}>
            <FieldLabel htmlFor="sso-admin-role-value">
              {localization.orgAdminRoleValue}
            </FieldLabel>
            <Input
              id="sso-admin-role-value"
              value={adminRoleValue}
              aria-invalid={Boolean(fieldErrors.adminRoleValue)}
              aria-describedby={describedBy("adminRoleValue")}
              onChange={(event) => setAdminRoleValue(event.target.value)}
            />
            <FieldDescription>
              {localization.orgAdminRoleValueHint}
            </FieldDescription>
            {fieldErrors.adminRoleValue && (
              <FieldError
                id="sso-adminRoleValue-error"
                errors={[{ message: fieldErrors.adminRoleValue }]}
              />
            )}
          </Field>

          <SsoServiceProviderInfo providerId={providerId} protocol={protocol} />

          <DialogFooter className="pt-2">
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
