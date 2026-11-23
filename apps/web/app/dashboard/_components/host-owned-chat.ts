import type { ChatItem } from "./dashboard-chat-types";

/**
 * A workspace assistant's own conversations: its Router work log and its
 * tickets' worker conversations. The assistant runs every turn in them and
 * depends on them, so the server refuses a member's send there and refuses
 * deleting, archiving or changing their visibility (403
 * `THREAD_HOST_OWNED`); the UI offers none of those.
 */
export function isHostOwnedChat(item: Pick<ChatItem, "origin"> | undefined) {
  return (
    item?.origin === "assistant_router" || item?.origin === "assistant_ticket"
  );
}
