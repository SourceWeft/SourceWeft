"use client";

import { useQuery } from "@tanstack/react-query";
import { contentClient } from "../../../../../lib/sdk";
import { mapThreadToChatItem } from "../../../_components/dashboard-chat-items";
import { isHostOwnedChat } from "../../../_components/host-owned-chat";

/**
 * When to look a thread up on its own: only once the chat lists have settled
 * and still do not hold it. An ordinary thread opened on a cold page is in
 * the first list page, so it never costs an extra request. `pending` keeps
 * the page from calling the thread missing while the lookup runs.
 */
export function unlistedLookupState(input: {
  workspaceId: string | null;
  listed: boolean;
  listsSettled: boolean;
  queryPending: boolean;
}) {
  const enabled =
    Boolean(input.workspaceId) && !input.listed && input.listsSettled;
  return { enabled, pending: enabled && input.queryPending };
}

/**
 * The assistant's Router conversation is left out of the chat list (and an
 * old ticket conversation may not be loaded yet), so a thread the settled
 * lists do not hold is looked up on its own. Only a host-owned one is used:
 * any other thread the lists do not hold keeps the page's existing handling.
 */
export function useUnlistedHostOwnedThread(input: {
  workspaceId: string | null;
  threadId: string;
  listed: boolean;
  listsSettled: boolean;
}) {
  const { workspaceId, threadId, listed, listsSettled } = input;
  const gate = unlistedLookupState({
    workspaceId,
    listed,
    listsSettled,
    queryPending: true,
  });
  const query = useQuery({
    queryKey: ["thread-item", workspaceId, threadId],
    queryFn: async () =>
      mapThreadToChatItem(
        (await contentClient.getThread(workspaceId!, threadId)).thread,
      ),
    enabled: gate.enabled,
    retry: false,
    staleTime: 60_000,
  });
  const { pending } = unlistedLookupState({
    workspaceId,
    listed,
    listsSettled,
    queryPending: query.isPending,
  });
  return {
    item: !listed && isHostOwnedChat(query.data) ? query.data : undefined,
    pending,
  };
}
