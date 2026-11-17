"use client"

import {
  hasMemberRole,
  type OrganizationAuthClient
} from "@better-auth-ui/core/plugins/organization"
import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import {
  useActiveMemberRole,
  useActiveOrganization
} from "@better-auth-ui/react/plugins/organization"
import { isPersonalOrganization } from "@sourceweft/contracts/organization-metadata"
import { AlertCircle, Plus } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from "@sourceweft/ui-web/components/ui/empty"
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

import { CopyableValue } from "./copyable-value"
import { ssoErrorMessage } from "./sso-errors"
import {
  SsoProviderDialog,
  type SsoProviderSummary
} from "./sso-provider-dialog"
import { SsoProviderList } from "./sso-provider-list"
import { buildServiceProviderUrls } from "./sso-service-provider-info"

/** Per-team provider cap, matching the backend guard's limit. */
const MAX_PROVIDERS = 5

export type OrganizationSsoProps = {
  organizationId: string
  organizationSlug: string
}

/**
 * Localized label for the organization "Single sign-on" tab. The tab entry is
 * built once in `lib/auth/sso-plugin.tsx` without a locale in scope, so the
 * label resolves its copy at render time through the plugin localization.
 */
export function SsoOrganizationTabLabel() {
  const { localization } = useAuthPlugin(ssoPlugin)
  return <>{localization.orgTabLabel}</>
}

function Notice({ children }: { children: string }) {
  return (
    <p className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
      {children}
    </p>
  )
}

/**
 * The "Single sign-on" organization settings tab. Lets team owners and admins
 * register, verify, edit and delete identity providers. SSO is a team feature:
 * a personal workspace sees a short notice and members without owner/admin see a
 * no-permission notice (the backend enforces both regardless).
 */
export function OrganizationSso({
  organizationId,
  organizationSlug
}: OrganizationSsoProps) {
  const {
    authClient,
    baseURL,
    localization: coreLocalization
  } = useAuth<SsoAuthClient & OrganizationAuthClient>()
  const { localization } = useAuthPlugin(ssoPlugin)

  const { data: activeOrganization, isPending: organizationPending } =
    useActiveOrganization(authClient)
  const isPersonal = activeOrganization
    ? isPersonalOrganization(activeOrganization)
    : false

  // Resolve the caller's own role via the dedicated endpoint, not by scanning a
  // paginated member list (the signed-in user may be off the first page). This
  // matches `organization-api-keys.tsx`.
  const { data: memberRole, isPending: rolePending } = useActiveMemberRole(
    authClient,
    {
      query: { organizationId },
      enabled: Boolean(organizationId) && Boolean(activeOrganization) && !isPersonal
    }
  )
  const isManager =
    hasMemberRole(memberRole?.role, "owner") ||
    hasMemberRole(memberRole?.role, "admin")

  const canManage = Boolean(activeOrganization) && !isPersonal && isManager

  const [providers, setProviders] = useState<SsoProviderSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProvider, setEditingProvider] =
    useState<SsoProviderSummary | undefined>(undefined)

  // `/sso/providers` returns providers of EVERY organization the caller admins,
  // so the result is scoped to the organization being viewed. A monotonic
  // request id drops out-of-order responses (a stale load for a previous
  // organization must never overwrite the current list).
  const requestIdRef = useRef(0)
  const loadProviders = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoadError(null)
    try {
      const result = await authClient.sso.providers()
      if (requestIdRef.current !== requestId) return
      if (result?.error) {
        setLoadError(
          ssoErrorMessage(
            result.error,
            localization,
            coreLocalization.errors.generic
          )
        )
        return
      }
      const all = (result?.data?.providers ?? []) as unknown as SsoProviderSummary[]
      setProviders(all.filter((p) => p.organizationId === organizationId))
    } catch {
      if (requestIdRef.current !== requestId) return
      setLoadError(coreLocalization.errors.generic)
    }
  }, [authClient, organizationId, coreLocalization, localization])

  // Load (and reload) only when the gate opens or the organization changes —
  // not whenever `loadProviders`'s identity shifts. A ref keeps the effect off
  // the callback's dependency list so an unstable `authClient`/`localization`
  // reference can't trigger a refetch loop.
  const loadProvidersRef = useRef(loadProviders)
  loadProvidersRef.current = loadProviders

  useEffect(() => {
    if (!canManage) return
    // Reset when the organization changes so another team's list never flashes.
    setProviders(null)
    void loadProvidersRef.current()
  }, [canManage, organizationId])

  if (organizationPending && !activeOrganization) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Spinner />
      </div>
    )
  }

  if (isPersonal) {
    return <Notice>{localization.orgTeamsOnly}</Notice>
  }

  if (rolePending) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Spinner />
      </div>
    )
  }

  if (!isManager) {
    return <Notice>{localization.orgNoPermission}</Notice>
  }

  const atLimit = (providers?.length ?? 0) >= MAX_PROVIDERS
  const verified = providers?.filter((p) => p.domainVerified) ?? []

  function openCreate() {
    setEditingProvider(undefined)
    setDialogOpen(true)
  }

  function openEdit(provider: SsoProviderSummary) {
    setEditingProvider(provider)
    setDialogOpen(true)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{localization.orgTitle}</h2>
          <p className="text-muted-foreground text-sm">
            {localization.orgDescription}
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button type="button" onClick={openCreate} disabled={atLimit}>
            <Plus />
            {localization.orgAddProvider}
          </Button>
          {atLimit && (
            <p className="text-muted-foreground text-xs">
              {localization.orgProviderLimitReached}
            </p>
          )}
        </div>
      </div>

      {/* Direct sign-in link lives once at the tab level: a shareable link only
          when exactly one provider is verified (several providers make `?org=`
          ambiguous), and a one-line explanation otherwise. */}
      {providers !== null && providers.length > 0 && (
        verified.length === 1 ? (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
            <p className="text-muted-foreground text-xs">
              {localization.orgDirectSignInDescription}
            </p>
            <CopyableValue
              label={localization.orgDirectSignInLink}
              value={
                buildServiceProviderUrls(
                  verified[0]!.providerId,
                  organizationSlug,
                  baseURL
                ).directSignInLink
              }
            />
          </div>
        ) : (
          <Notice>
            {verified.length === 0
              ? localization.orgDirectSignInNone
              : localization.orgDirectSignInMany}
          </Notice>
        )
      )}

      {loadError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {providers === null ? (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Spinner />
        </div>
      ) : providers.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{localization.orgEmptyTitle}</EmptyTitle>
            <EmptyDescription>
              {localization.orgEmptyDescription}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SsoProviderList
          providers={providers}
          onEdit={openEdit}
          onChanged={loadProviders}
        />
      )}

      {dialogOpen && (
        <SsoProviderDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          organizationId={organizationId}
          provider={editingProvider}
          onSaved={loadProviders}
        />
      )}
    </div>
  )
}
