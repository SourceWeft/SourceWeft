"use client"

import { formatDisplayDate } from "@/lib/i18n/format"
import { useLocale as useDisplayLocale } from "next-intl"
import type { ListedApiKey } from "@better-auth-ui/core/plugins/api-key"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { Key, Pencil, X } from "lucide-react"
import { useState } from "react"

import { Button } from "@sourceweft/ui-web/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@sourceweft/ui-web/components/ui/item"
import { apiKeyPlugin } from "@/lib/auth/api-key-plugin"
import { DeleteApiKeyDialog } from "./delete-api-key-dialog"
import { EditApiKeyDialog } from "./edit-api-key-dialog"

export type ApiKeyProps = {
  apiKey: ListedApiKey
  /** Hide the row's delete button (e.g., when caller lacks `apiKey:delete`). */
  hideDelete?: boolean
  /** Hide the row's edit button (e.g., when caller lacks `apiKey:update`). */
  hideUpdate?: boolean
  /** Scope the delete payload to an organization (sets `configId`). */
  organizationId?: string
}

export function ApiKey({
  apiKey,
  hideDelete,
  hideUpdate,
  organizationId,
}: ApiKeyProps) {
  const displayLocale = useDisplayLocale()
  const { localization } = useAuth()
  const { localization: apiKeyLocalization } = useAuthPlugin(apiKeyPlugin)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const preview = `${apiKey.start}${"*".repeat(16)}`

  return (
    <Item>
      <ItemMedia variant="icon">
        <Key />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{apiKey.name || apiKeyLocalization.apiKey}</ItemTitle>
        <ItemDescription className="font-mono">{preview}</ItemDescription>
        <ItemDescription>
          {apiKeyLocalization.created}{" "}
          {formatDisplayDate(new Date(apiKey.createdAt), displayLocale, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </ItemDescription>
        <ItemDescription>
          {apiKey.expiresAt
            ? `${apiKeyLocalization.expires} ${formatDisplayDate(
                new Date(apiKey.expiresAt),
                displayLocale,
                {
                  dateStyle: "medium",
                  timeStyle: "short",
                },
              )}`
            : apiKeyLocalization.neverExpires}
        </ItemDescription>
        <ItemDescription>
          {apiKey.enabled
            ? apiKeyLocalization.enabled
            : apiKeyLocalization.disabled}
          {` · ${apiKeyLocalization.requests}: ${apiKey.requestCount}`}
          {apiKey.remaining === null
            ? ""
            : ` · ${apiKeyLocalization.remaining}: ${apiKey.remaining}`}
        </ItemDescription>
        <ItemDescription>
          {apiKeyLocalization.lastRequest}:{" "}
          {apiKey.lastRequest
            ? formatDisplayDate(new Date(apiKey.lastRequest), displayLocale)
            : apiKeyLocalization.neverRequested}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {!hideUpdate && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              <Pencil />
              {apiKeyLocalization.editApiKey}
            </Button>
            <EditApiKeyDialog
              apiKey={apiKey}
              open={editOpen}
              onOpenChange={setEditOpen}
            />
          </>
        )}
        {!hideDelete && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              aria-label={apiKeyLocalization.deleteApiKey}
            >
              <X />

              {localization.settings.delete}
            </Button>

            <DeleteApiKeyDialog
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              apiKey={apiKey}
              organizationId={organizationId}
            />
          </>
        )}
      </ItemActions>
    </Item>
  )
}
