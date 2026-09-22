"use client"

import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia
} from "@sourceweft/ui-web/components/ui/item"
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton"

/**
 * Placeholder row matching `UserInvitationRow` while invitations load.
 */
export function UserInvitationRowSkeleton() {
  return (
    <Item>
      <ItemMedia variant="icon">
        <Skeleton className="size-4 shrink-0 rounded-sm" />
      </ItemMedia>
      <ItemContent>
        <Skeleton className="h-4 w-40 rounded-md" />
        <Skeleton className="h-3 w-28 rounded-md" />
      </ItemContent>
      <ItemActions>
        <Skeleton className="h-8 w-20" />
        <Skeleton className="size-8" />
      </ItemActions>
    </Item>
  )
}
