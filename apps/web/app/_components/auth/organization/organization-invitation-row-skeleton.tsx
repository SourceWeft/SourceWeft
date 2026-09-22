"use client"

import { Skeleton } from "@sourceweft/ui-web/components/ui/skeleton"
import { TableCell, TableRow } from "@sourceweft/ui-web/components/ui/table"

/**
 * Placeholder row matching `OrganizationInvitationRow` while invitations load.
 */
export function OrganizationInvitationRowSkeleton({
  showSelection = false,
  showEmail = true,
  showCreatedAt = true,
  showRole = true,
  showStatus = true
}: {
  showSelection?: boolean
  showEmail?: boolean
  showCreatedAt?: boolean
  showRole?: boolean
  showStatus?: boolean
} = {}) {
  return (
    <TableRow>
      {showSelection && (
        <TableCell>
          <Skeleton className="size-4" />
        </TableCell>
      )}
      {showEmail && (
        <TableCell>
          <Skeleton className="h-4 w-48 rounded-md" />
        </TableCell>
      )}

      {showCreatedAt && (
        <TableCell>
          <Skeleton className="h-4 w-36 rounded-md" />
        </TableCell>
      )}

      {showRole && (
        <TableCell>
          <Skeleton className="h-4 w-16 rounded-md" />
        </TableCell>
      )}

      {showStatus && (
        <TableCell>
          <Skeleton className="h-4 w-14 rounded-full" />
        </TableCell>
      )}

      <TableCell>
        <Skeleton className="ml-auto size-8 rounded-md" />
      </TableCell>
    </TableRow>
  )
}
