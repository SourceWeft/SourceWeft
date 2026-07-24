import { or, eq, ne, and, type SQL, type AnyColumn } from "drizzle-orm";

/**
 * Visibility model (Model A).
 *
 * The workspace is the sharing boundary. A team workspace is fully shared;
 * privacy is achieved by working in one's personal workspace (a single-member
 * workspace), not by flagging individual items. So there is exactly one
 * per-item visibility control in the product: a **thread** can be private or
 * shared with the workspace.
 *
 * Everything else derives from that, never from its own toggle:
 * - **Sources** carry no visibility at all — every member of a workspace sees
 *   its whole source library. This is why a shared thread never has a dangling
 *   reference: the sources it cites are always visible to whoever can open it.
 * - **Artifacts** inherit the visibility of the thread that produced them
 *   (private thread → private artifact; otherwise workspace-visible). The
 *   `artifacts.visibility` column is a denormalized copy the thread keeps in
 *   sync; users never set it directly.
 * - **Working files** are thread-scoped and gated by thread access.
 *
 * `public_link` (external sharing) is a separate, deliberate publish action,
 * not part of this internal private/workspace axis.
 */
export type ContentVisibility = "private" | "workspace";

/**
 * Who is asking, for the purpose of row-level visibility.
 *
 * `role` is the caller's content role in the workspace, as resolved by
 * `WorkspaceService.resolveAccess`. A `null` role means container-only
 * standing (an organization admin who is not a member of the workspace) — that
 * carries no right to read member content, and the boundary is enforced before
 * reaching here, so this module never sees it.
 */
export type ContentViewer = {
  userId: string;
};

/**
 * Restricts a content query to what `viewer` may see: everything marked
 * `workspace`, plus their own `private` rows.
 *
 * The shape mirrors LobeChat's `buildWorkspaceWhere`. Two deliberate choices:
 *
 * - A NULL `created_by` private row is visible to nobody. That is correct —
 *   an unowned private row has no one it could belong to — but it means
 *   private is only ever set together with a real creator. Inserts set
 *   `created_by`, so this does not strand ordinary content.
 * - This is layered *on top of* the workspace-scope predicate the caller
 *   already applies (`workspace_id = ?`). It never widens a query; it only
 *   removes other members' private rows from an already workspace-scoped set.
 */
export function visibleContentWhere(
  viewer: ContentViewer,
  cols: { visibility: AnyColumn; createdBy: AnyColumn },
): SQL {
  return or(
    ne(cols.visibility, "private"),
    and(eq(cols.visibility, "private"), eq(cols.createdBy, viewer.userId)),
  ) as SQL;
}

/**
 * In-memory counterpart to `visibleContentWhere`, for a row already loaded.
 * Use at single-record choke points (guards) where the SQL predicate cannot
 * run. A NULL creator on a private row belongs to no one and is hidden.
 */
export function canViewContent(
  viewerUserId: string,
  row: { visibility: ContentVisibility; createdBy: string | null },
): boolean {
  return row.visibility !== "private" || row.createdBy === viewerUserId;
}

/**
 * In-memory thread visibility check, for a loaded thread. `public_link` is an
 * external-sharing flag, not an internal hide, so only `private` restricts.
 * Same fail-closed rule as `canViewContent`: a creator-less private row is
 * visible to nobody (legacy pre-creator-tracking threads were backfilled to
 * `workspace` in migration 0019, so no real rows hit that branch). The raw-SQL
 * counterpart lives in the threads repository (`threadVisibilityClause`)
 * because threads are queried without drizzle.
 */
export function canViewThread(
  viewerUserId: string,
  row: { visibility: string; createdBy: string | null },
): boolean {
  return row.visibility !== "private" || row.createdBy === viewerUserId;
}
