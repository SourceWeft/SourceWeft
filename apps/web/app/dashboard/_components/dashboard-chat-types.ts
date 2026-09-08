export type ChatVisibility = "private" | "workspace" | "public_link";

export type ChatItem = {
  id: string;
  title: string;
  updatedAt: string;
  sourceCount: number;
  visibility: ChatVisibility;
  status?: "ready" | "running" | "attention";
  /** The thread this sub-agent conversation nests under; null at top level. */
  parentThreadId: string | null;
  /** The persona driving the thread; null for an ordinary chat. */
  personaId: string | null;
  /** One visible level: the sub-agent conversations nested under this chat. */
  children?: ChatItem[];
};

/** True for a thread that is visible to the whole workspace, not just its author. */
export function isSharedChat(item: Pick<ChatItem, "visibility">) {
  return item.visibility !== "private";
}
