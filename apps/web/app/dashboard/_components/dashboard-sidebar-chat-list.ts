import { isSharedChat, type ChatItem } from "./dashboard-chat-types";

export type ChatVisibilityFilter = "all" | "shared" | "private";

export function getSidebarChatItems({
  privateChats,
  sharedChats,
  archivedChats,
  view,
  filter,
}: {
  privateChats: ChatItem[];
  sharedChats: ChatItem[];
  archivedChats: ChatItem[];
  view: "chats" | "archived";
  filter: ChatVisibilityFilter;
}): ChatItem[] {
  const archivedIds = new Set(archivedChats.map((item) => item.id));
  const candidates =
    view === "archived"
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
        (filter === "shared" ? isSharedChat(item) : !isSharedChat(item)),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
