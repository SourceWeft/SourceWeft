import type { ThreadExecutionTarget } from "@sourceweft/contracts";
import type { ChatItem } from "./dashboard-chat-types";

/** The thread shape the sidebar needs; every API thread response satisfies it. */
export type ChatThreadLike = {
  id: string;
  title: string;
  sourceCount?: number | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  lastMessageAt?: string | null;
  visibility?: ChatItem["visibility"] | null;
  executionTarget?: ThreadExecutionTarget;
  parentThreadId?: string | null;
  personaId?: string | null;
  children?: ChatThreadLike[] | null;
};

export function normalizeUpdatedAt(value?: string | null) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

export function mapThreadToChatItem(item: ChatThreadLike): ChatItem {
  return {
    id: item.id,
    executionTarget: item.executionTarget,
    title: item.title,
    // Sort/display timestamp is conversation activity — last message, falling
    // back to creation. NOT updatedAt, which metadata writes (title/model/
    // prefs) bump, which used to make the list reshuffle on every title.
    updatedAt: normalizeUpdatedAt(
      item.lastMessageAt ?? item.createdAt ?? item.updatedAt,
    ),
    sourceCount: item.sourceCount ?? 0,
    // A thread persisted before visibility existed reads as private, matching
    // the column's own default and keeping it out of the shared bucket.
    visibility: item.visibility ?? "private",
    status: "ready",
    parentThreadId: item.parentThreadId ?? null,
    personaId: item.personaId ?? null,
    // The sidebar nests one level, so a child's own children are dropped. The
    // key is only set when the response carried children: a single-thread
    // response has none, and spreading it over a list item must keep the
    // children that item already shows.
    ...(item.children
      ? {
          children: item.children.map((child) =>
            mapThreadToChatItem({ ...child, children: null }),
          ),
        }
      : {}),
  };
}

/** Finds a chat at the top level or nested one level down. */
export function findChatItem(
  items: readonly ChatItem[],
  id: string,
): ChatItem | undefined {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }
    const child = item.children?.find((candidate) => candidate.id === id);
    if (child) {
      return child;
    }
  }
  return undefined;
}

/** Applies `update` to every chat, top level and nested. */
export function mapChatItems(
  items: ChatItem[],
  update: (item: ChatItem) => ChatItem,
): ChatItem[] {
  return items.map((item) => {
    const next = update(item);
    return next.children
      ? { ...next, children: next.children.map(update) }
      : next;
  });
}

/** Removes a chat wherever it sits: a top-level row or a nested child. */
export function removeChatItem(items: ChatItem[], id: string): ChatItem[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) =>
      item.children?.some((child) => child.id === id)
        ? {
            ...item,
            children: item.children.filter((child) => child.id !== id),
          }
        : item,
    );
}

/**
 * Nests `child` under its parent, newest first, replacing an earlier copy.
 * Returns null when the parent is not in `items`, so the caller can decide
 * where an orphan should show instead.
 */
export function insertChildChatItem(
  items: ChatItem[],
  child: ChatItem,
): ChatItem[] | null {
  const parentId = child.parentThreadId;
  if (!parentId) {
    return null;
  }
  let inserted = false;
  const next = items.map((item) => {
    if (item.id !== parentId) {
      return item;
    }
    inserted = true;
    const others = (item.children ?? []).filter(
      (candidate) => candidate.id !== child.id,
    );
    return { ...item, children: [child, ...others] };
  });
  return inserted ? next : null;
}

/** Every chat in display order, parents followed by their children. */
export function flattenChatItems(items: readonly ChatItem[]): ChatItem[] {
  return items.flatMap((item) => [item, ...(item.children ?? [])]);
}
