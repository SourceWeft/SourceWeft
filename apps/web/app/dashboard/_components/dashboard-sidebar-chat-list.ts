import { isSharedChat, type ChatItem } from "./dashboard-chat-types";

export type SidebarChatFilter =
  "all" | "shared" | "private" | "scheduled" | "assistant" | "archived";

export function getSidebarChatItems({
  privateChats,
  sharedChats,
  archivedChats,
  filter,
}: {
  privateChats: ChatItem[];
  sharedChats: ChatItem[];
  archivedChats: ChatItem[];
  filter: SidebarChatFilter;
}): ChatItem[] {
  const archivedIds = new Set(archivedChats.map((item) => item.id));
  const candidates =
    filter === "archived"
      ? archivedChats
      : [...sharedChats, ...privateChats].filter(
          (item) => !archivedIds.has(item.id),
        );
  const unique = new Map<string, ChatItem>();
  for (const item of candidates) {
    const previous = unique.get(item.id);
    if (
      !previous ||
      Date.parse(item.updatedAt) > Date.parse(previous.updatedAt)
    ) {
      unique.set(item.id, item);
    }
  }

  return [...unique.values()]
    .filter(
      (item) =>
        filter === "all" ||
        filter === "archived" ||
        (filter === "scheduled"
          ? item.origin === "scheduled"
          : filter === "assistant"
            ? // A workspace assistant's ticket conversations; its Router
              // conversation is a work log and never listed.
              item.origin === "assistant_ticket"
            : filter === "shared"
              ? isSharedChat(item)
              : !isSharedChat(item)),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Splits a sidebar view into its pinned chats (in pin order) and the rest
 * (in their existing order). The archived view has no pinned section.
 */
export function splitPinnedChats(
  items: ChatItem[],
  pinnedIds: readonly string[],
  filter: SidebarChatFilter,
): { pinned: ChatItem[]; rest: ChatItem[] } {
  if (filter === "archived" || pinnedIds.length === 0) {
    return { pinned: [], rest: items };
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const pinnedSet = new Set(pinnedIds);
  return {
    pinned: pinnedIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    }),
    rest: items.filter((item) => !pinnedSet.has(item.id)),
  };
}
