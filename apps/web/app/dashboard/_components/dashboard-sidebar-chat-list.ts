import { isSharedChat, type ChatItem } from "./dashboard-chat-types";

export type SidebarChatFilter = "all" | "shared" | "private" | "archived";

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
        (filter === "shared" ? isSharedChat(item) : !isSharedChat(item)),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
