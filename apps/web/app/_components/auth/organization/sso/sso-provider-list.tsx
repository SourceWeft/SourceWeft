"use client"

import { useAuthPlugin } from "@better-auth-ui/react"
import { ChevronDown, Pencil, Trash2 } from "lucide-react"
import { Fragment, useState } from "react"

import { Badge } from "@sourceweft/ui-web/components/ui/badge"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@sourceweft/ui-web/components/ui/table"
import { cn } from "@sourceweft/ui-web/lib/utils"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

import { DeleteSsoProviderDialog } from "./delete-sso-provider-dialog"
import { SsoDomainVerification } from "./sso-domain-verification"
import type { SsoProviderSummary } from "./sso-provider-dialog"
import { SsoServiceProviderInfo } from "./sso-service-provider-info"

export type SsoProviderListProps = {
  providers: SsoProviderSummary[]
  onEdit: (provider: SsoProviderSummary) => void
  /** Refresh the list after a delete or a successful verification. */
  onChanged: () => void
}

/**
 * Table of the organization's identity providers. Each row carries its status
 * and actions; a details row (expanded on demand, and always shown while a
 * domain is unverified) holds the service-provider endpoints and the domain
 * verification panel.
 */
export function SsoProviderList({
  providers,
  onEdit,
  onChanged
}: SsoProviderListProps) {
  const { localization } = useAuthPlugin(ssoPlugin)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [providerToDelete, setProviderToDelete] =
    useState<SsoProviderSummary | null>(null)

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table aria-label={localization.orgTitle}>
          <TableHeader>
            <TableRow>
              <TableHead>{localization.orgColumnProvider}</TableHead>
              <TableHead>{localization.orgColumnDomain}</TableHead>
              <TableHead>{localization.orgColumnType}</TableHead>
              <TableHead>{localization.orgColumnStatus}</TableHead>
              <TableHead className="text-right">
                {localization.orgColumnActions}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((provider) => {
              const expanded = expandedId === provider.providerId
              const showDetails = expanded || !provider.domainVerified
              return (
                <Fragment key={provider.providerId}>
                  <TableRow>
                    <TableCell className="font-mono text-xs">
                      {provider.providerId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {provider.domain}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {provider.type === "saml"
                          ? localization.orgProtocolSaml
                          : localization.orgProtocolOidc}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {provider.domainVerified ? (
                        <Badge variant="secondary">
                          {localization.orgStatusVerified}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          {localization.orgStatusPending}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedId(expanded ? null : provider.providerId)
                          }
                        >
                          <ChevronDown
                            className={cn(
                              "transition-transform",
                              expanded && "rotate-180"
                            )}
                          />
                          {localization.orgDetails}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onEdit(provider)}
                        >
                          <Pencil />
                          {localization.orgEdit}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setProviderToDelete(provider)}
                        >
                          <Trash2 />
                          {localization.orgDelete}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>

                  {showDetails && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={5}>
                        <div className="flex flex-col gap-3">
                          {!provider.domainVerified && (
                            <SsoDomainVerification
                              key={`${provider.providerId}-verify`}
                              providerId={provider.providerId}
                              domain={provider.domain}
                              onVerified={onChanged}
                            />
                          )}
                          {expanded && (
                            <SsoServiceProviderInfo
                              providerId={provider.providerId}
                              protocol={provider.type === "saml" ? "saml" : "oidc"}
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {providerToDelete && (
        <DeleteSsoProviderDialog
          open={Boolean(providerToDelete)}
          onOpenChange={(next) => {
            if (!next) setProviderToDelete(null)
          }}
          provider={providerToDelete}
          onDeleted={onChanged}
        />
      )}
    </>
  )
}
