"use client"

import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { TriangleAlert } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle
} from "@sourceweft/ui-web/components/ui/alert-dialog"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

import { ssoErrorMessage } from "./sso-errors"

export type DeleteSsoProviderDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: { providerId: string; domain: string }
  /** Called after the provider is deleted so the caller can refresh the list. */
  onDeleted: () => void
}

/**
 * Destructive confirmation for removing an identity provider. Names the domain
 * and spells out that members on it lose SSO sign-in, since deletion cannot be
 * undone.
 */
export function DeleteSsoProviderDialog({
  open,
  onOpenChange,
  provider,
  onDeleted
}: DeleteSsoProviderDialogProps) {
  const { authClient, localization: coreLocalization } = useAuth<SsoAuthClient>()
  const { localization } = useAuthPlugin(ssoPlugin)
  const [isDeleting, setIsDeleting] = useState(false)

  async function handleDelete() {
    if (isDeleting) return
    setIsDeleting(true)
    try {
      const result = await authClient.sso.deleteProvider({
        providerId: provider.providerId
      })
      if (result?.error) {
        toast.error(
          ssoErrorMessage(
            result.error,
            localization,
            coreLocalization.errors.generic
          )
        )
        return
      }
      toast.success(localization.orgDeleteSuccess)
      onOpenChange(false)
      onDeleted()
    } catch {
      toast.error(coreLocalization.errors.generic)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <TriangleAlert />
          </AlertDialogMedia>
          <AlertDialogTitle>{localization.orgDeleteTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {localization.orgDeleteDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <span className="font-mono">{provider.domain}</span>{" "}
          <span className="text-muted-foreground">({provider.providerId})</span>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>
            {localization.orgCancel}
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting && <Spinner data-icon="inline-start" />}
            {localization.orgDeleteConfirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
