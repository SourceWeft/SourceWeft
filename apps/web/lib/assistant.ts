"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { hasMemberRole } from "@better-auth-ui/core/plugins/organization";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type { UpdateAssistantRequest } from "@sourceweft/contracts/assistants";
import { HttpClientError } from "@sourceweft/sdk";
import { assistantClient, workspaceClient } from "./sdk";

/**
 * The feed and the ticket list are refreshed this often while the page is
 * visible. TanStack Query pauses an interval while the tab is hidden
 * (`refetchIntervalInBackground` is off by default), so a background tab
 * does not keep polling.
 */
export const ASSISTANT_POLL_MS = 5_000;

/** Feed items per page; the backend's own default. */
const FEED_PAGE_SIZE = 50;

/** Every key carries the workspace, so switching workspaces never shows another's assistant. */
export const assistantKeys = {
  all: (workspaceId: string | null) => ["assistant", workspaceId] as const,
  assistant: (workspaceId: string | null) =>
    ["assistant", workspaceId, "assistant"] as const,
  feed: (workspaceId: string | null) =>
    ["assistant", workspaceId, "feed"] as const,
  tickets: (workspaceId: string | null) =>
    ["assistant", workspaceId, "tickets"] as const,
  members: (workspaceId: string | null) =>
    ["assistant", workspaceId, "members"] as const,
};

/** The refusal's stable code (`ASSISTANT_PAUSED`, ...), if it has one. */
export function assistantErrorCode(error: unknown) {
  return error instanceof HttpClientError ? error.code : null;
}

/** The workspace's assistant, or `null` while it has not been enabled. */
export function useAssistant(workspaceId: string | null) {
  return useQuery({
    queryKey: assistantKeys.assistant(workspaceId),
    queryFn: () => assistantClient.get(workspaceId!),
    enabled: Boolean(workspaceId),
    select: (data) => data.assistant,
  });
}

/** The shared timeline, newest first; older pages load on request. */
export function useAssistantFeed(workspaceId: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: assistantKeys.feed(workspaceId),
    queryFn: ({ pageParam }) =>
      assistantClient.listFeed(workspaceId!, {
        limit: FEED_PAGE_SIZE,
        ...(pageParam ? { before: pageParam } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: ASSISTANT_POLL_MS,
  });
}

/** Every ticket, ended ones included (the feed links to them). */
export function useAssistantTickets(
  workspaceId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: assistantKeys.tickets(workspaceId),
    queryFn: () => assistantClient.listTickets(workspaceId!),
    enabled: enabled && Boolean(workspaceId),
    select: (data) => data.tickets,
    refetchInterval: ASSISTANT_POLL_MS,
  });
}

/** The workspace's members: names for the feed and the steward picker. */
export function useAssistantMembers(workspaceId: string | null) {
  return useQuery({
    queryKey: assistantKeys.members(workspaceId),
    queryFn: () => workspaceClient.listWorkspaceMembers(workspaceId!),
    enabled: Boolean(workspaceId),
    select: (data) => data.items,
  });
}

/**
 * What the page may offer the viewer. The server decides every action; this
 * only hides controls that would certainly be refused. A container admin is
 * an organization owner or admin, the same rule the backend applies.
 */
export function viewerStanding(
  members: readonly WorkspaceMember[] | undefined,
  viewerId: string | null,
) {
  const me = viewerId
    ? members?.find((member) => member.userId === viewerId)
    : undefined;
  return {
    isAdmin: Boolean(
      me &&
      (hasMemberRole(me.organizationRole, "owner") ||
        hasMemberRole(me.organizationRole, "admin")),
    ),
    canWrite: Boolean(me && me.role !== "viewer"),
  };
}

/** Every assistant action refreshes the assistant, its feed and its tickets. */
export function useAssistantMutations(workspaceId: string | null) {
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: assistantKeys.all(workspaceId) });
  const need = () => {
    if (!workspaceId) throw new Error("No workspace is selected");
    return workspaceId;
  };
  const useAction = <Input, Output>(run: (input: Input) => Promise<Output>) =>
    useMutation({ mutationFn: run, onSettled: refresh });

  return {
    enable: useAction(() => assistantClient.enable(need())),
    update: useAction((input: UpdateAssistantRequest) =>
      assistantClient.update(need(), input),
    ),
    /** The caller mints the key, so a retry of the same send can reuse it. */
    postMessage: useAction((input: { text: string; idempotencyKey: string }) =>
      assistantClient.postMessage(need(), input),
    ),
    closeTicket: useAction((ticketId: string) =>
      assistantClient.closeTicket(need(), ticketId, {
        // A fresh key per click. A double click is stopped by the buttons'
        // busy state, not by the key; closing an ended ticket is a no-op.
        idempotencyKey: crypto.randomUUID(),
      }),
    ),
    retryTicket: useAction((ticketId: string) =>
      assistantClient.retryTicket(need(), ticketId, {
        idempotencyKey: crypto.randomUUID(),
      }),
    ),
  };
}
