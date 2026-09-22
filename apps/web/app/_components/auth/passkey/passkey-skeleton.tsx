"use client"

import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia
} from "@sourceweft/ui-web/components/ui/item"
import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton"

export function PasskeySkeleton() {
  return (
    <Item>
      <ItemMedia variant="icon">
        <Skeleton className="size-4 rounded-sm" />
      </ItemMedia>
      <ItemContent>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-32" />
      </ItemContent>
      <ItemActions>
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
      </ItemActions>
    </Item>
  )
}
