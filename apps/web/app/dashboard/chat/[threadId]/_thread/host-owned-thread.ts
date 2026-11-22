"use client";

import { useQuery } from "@tanstack/react-query";
import { contentClient } from "../../../../../lib/sdk";
import { mapThreadToChatItem } from "../../../_components/dashboard-chat-items";
import type { ChatItem } from "../../../_components/dashboard-chat-types";

/**
 * A workspace assistant's own conversations: its Router work log and its
 * tickets' worker conversations. The assistant runs every turn in them; a
 * member may read them, but the server refuses a member's send there
 * (403 `THREAD_HOST_OWNED`), so the page offers no composer.
 */
export function isHostOwnedChat(item: Pick<ChatItem, "origin"> | undefined) {
  return (
    item?.origin === "assistant_router" || item?.origin === "assistant_ticket"
  );
}

/**
 * The assistant's Router conversation is left out of the chat list (and an
 * old ticket conversation may not be loaded yet), so a thread the lists do
 * not hold is looked up on its own. Only a host-owned one is used: any other
 * thread the lists do not hold keeps the page's existing handling.
 */
export function useUnlistedHostOwnedThread(
  workspaceId: string | null,
  threadId: string,
  listed: boolean,
) {
  const query = useQuery({
    queryKey: ["thread-item", workspaceId, threadId],
    queryFn: async () =>
      mapThreadToChatItem(
        (await contentClient.getThread(workspaceId!, threadId)).thread,
      ),
    enabled: !listed && Boolean(workspaceId),
    retry: false,
    staleTime: 60_000,
  });
  return {
    item: !listed && isHostOwnedChat(query.data) ? query.data : undefined,
    /** Still finding out; the page must not call the thread missing yet. */
    pending: !listed && Boolean(workspaceId) && query.isPending,
  };
}
