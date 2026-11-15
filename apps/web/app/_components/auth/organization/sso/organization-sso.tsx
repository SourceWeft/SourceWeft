"use client"

import type { OrganizationAuthClient } from "@better-auth-ui/core/plugins/organization"
import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin, useSession } from "@better-auth-ui/react"
import {
  useActiveOrganization,
  useListOrganizationMembers
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

import { ssoErrorMessage } from "./sso-errors"
import {
  SsoProviderDialog,
  type SsoProviderSummary
} from "./sso-provider-dialog"
import { SsoProviderList } from "./sso-provider-list"

/** Per-team provider cap, matching the backend guard's limit. */
const MAX_PROVIDERS = 5

const MANAGER_ROLES = new Set(["owner", "admin"])

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
  const { authClient, localization: coreLocalization } =
    useAuth<SsoAuthClient & OrganizationAuthClient>()
  const { localization } = useAuthPlugin(ssoPlugin)

  const { data: activeOrganization, isPending: organizationPending } =
    useActiveOrganization(authClient)
  const isPersonal = activeOrganization
    ? isPersonalOrganization(activeOrganization)
    : false

  const { data: session } = useSession(authClient)
  const { data: membersData, isPending: membersPending } =
    useListOrganizationMembers(authClient, {
      query: { organizationId },
      enabled: Boolean(organizationId) && Boolean(activeOrganization) && !isPersonal
    })

  const membership = membersData?.members?.find(
    (member: { userId: string; role: string }) =>
      member.userId === session?.user?.id
  )
  const isManager = (membership?.role ?? "")
    .split(",")
    .map((role: string) => role.trim())
    .some((role: string) => MANAGER_ROLES.has(role))

  const canManage = Boolean(activeOrganization) && !isPersonal && isManager

  const [providers, setProviders] = useState<SsoProviderSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProvider, setEditingProvider] =
    useState<SsoProviderSummary | undefined>(undefined)

  const loadProviders = useCallback(async () => {
    setLoadError(null)
    try {
      const result = await authClient.sso.providers()
      if (result?.error) {
        setLoadError(
          ssoErrorMessage(
            result.error,
            localization.orgRateLimited,
            coreLocalization.errors.generic
          )
        )
        return
      }
      setProviders(
        (result?.data?.providers ?? []) as unknown as SsoProviderSummary[]
      )
    } catch {
      setLoadError(coreLocalization.errors.generic)
    }
  }, [authClient, coreLocalization, localization.orgRateLimited])

  // Load (and reload) only when the gate opens or the organization changes —
  // not whenever `loadProviders`'s identity shifts. A ref keeps the effect off
  // the callback's dependency list so an unstable `authClient`/`localization`
  // reference can't trigger a refetch loop.
  const loadProvidersRef = useRef(loadProviders)
  loadProvidersRef.current = loadProviders

  useEffect(() => {
    if (!canManage) return
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

  if (membersPending) {
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
          organizationSlug={organizationSlug}
          onEdit={openEdit}
          onChanged={loadProviders}
        />
      )}

      {dialogOpen && (
        <SsoProviderDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          organizationId={organizationId}
          organizationSlug={organizationSlug}
          provider={editingProvider}
          onSaved={loadProviders}
        />
      )}
    </div>
  )
}
