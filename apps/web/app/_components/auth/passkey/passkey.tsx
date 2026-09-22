"use client"

import { formatDisplayDate } from "@/lib/i18n/format"
import { useLocale as useDisplayLocale } from "next-intl"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { Fingerprint, Pencil, X } from "lucide-react"
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
import { passkeyPlugin } from "@/lib/auth/passkey-plugin"

import {
  DeletePasskeyDialog,
  type ListedPasskey,
} from "./delete-passkey-dialog"
import { RenamePasskeyDialog } from "./rename-passkey-dialog"

export type PasskeyProps = {
  passkey: ListedPasskey
}

export function Passkey({ passkey }: PasskeyProps) {
  const displayLocale = useDisplayLocale()
  const { localization } = useAuth()
  const { localization: passkeyLocalization } = useAuthPlugin(passkeyPlugin)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)

  const passkeyName = passkey.name || passkeyLocalization.passkey

  return (
    <Item>
      <ItemMedia variant="icon">
        <Fingerprint />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{passkeyName}</ItemTitle>
        <ItemDescription>
          {formatDisplayDate(new Date(passkey.createdAt), displayLocale, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="outline" size="sm" onClick={() => setRenameOpen(true)}>
          <Pencil />
          {passkeyLocalization.renamePasskey}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDeleteOpen(true)}
          aria-label={passkeyLocalization.deletePasskey.replace(
            "{{name}}",
            passkeyName,
          )}
        >
          <X />

          {localization.settings.delete}
        </Button>

        <DeletePasskeyDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          passkey={passkey}
        />
        <RenamePasskeyDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          passkey={passkey}
        />
      </ItemActions>
    </Item>
  )
}
