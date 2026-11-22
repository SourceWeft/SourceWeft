import type { WorkspaceMember } from "@sourceweft/contracts";

/** A member's display name, or null when they are no longer listed. */
export function memberName(
  members: readonly WorkspaceMember[],
  userId: string | null,
) {
  if (!userId) return null;
  const member = members.find((entry) => entry.userId === userId);
  return member ? member.name || member.email || null : null;
}
