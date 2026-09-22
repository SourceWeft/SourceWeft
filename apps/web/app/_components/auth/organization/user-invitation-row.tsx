"use client"

import { formatDisplayDate } from "@/lib/i18n/format"
import { useLocale as useDisplayLocale } from "next-intl"
import type { OrganizationAuthClient } from "@better-auth-ui/core/plugins/organization"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import {
  useAcceptInvitation,
  useRejectInvitation,
} from "@better-auth-ui/react/plugins/organization"
import type { Invitation } from "better-auth/client"
import { Check, Clock, X } from "lucide-react"

import { Badge } from "@sourceweft/ui-web/components/ui/badge"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@sourceweft/ui-web/components/ui/item"
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner"
import { organizationPlugin } from "@/lib/auth/organization-plugin"

export type UserInvitationRowProps = {
  invitation: Invitation & { organizationName?: string }
}

/**
 * Single invitation row with accept/reject actions for the current user.
 */
export function UserInvitationRow({ invitation }: UserInvitationRowProps) {
  const displayLocale = useDisplayLocale()
  const { authClient } = useAuth<OrganizationAuthClient>()
  const { localization: organizationLocalization, roles } =
    useAuthPlugin(organizationPlugin)

  const { mutate: acceptInvitation, isPending: isAccepting } =
    useAcceptInvitation(authClient)

  const { mutate: rejectInvitation, isPending: isRejecting } =
    useRejectInvitation(authClient)

  return (
    <Item>
      <ItemMedia variant="icon">
        <Clock />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {invitation.organizationName}
          <Badge variant="secondary">
            {roles?.[invitation.role] ?? invitation.role}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {formatDisplayDate(new Date(invitation.createdAt), displayLocale, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          disabled={isAccepting || isRejecting}
          onClick={() => acceptInvitation({ invitationId: invitation.id })}
        >
          {isAccepting ? <Spinner /> : <Check />}

          {organizationLocalization.accept}
        </Button>

        <Button
          variant="outline"
          size="icon"
          className="size-8 text-destructive"
          disabled={isAccepting || isRejecting}
          onClick={() => rejectInvitation({ invitationId: invitation.id })}
          aria-label={organizationLocalization.rejectInvitation}
        >
          {isRejecting ? <Spinner /> : <X />}
        </Button>
      </ItemActions>
    </Item>
  )
}
