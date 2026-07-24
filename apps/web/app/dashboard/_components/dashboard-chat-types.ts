export type ChatVisibility = "private" | "workspace" | "public_link";

export type ChatItem = {
  id: string;
  title: string;
  updatedAt: string;
  sourceCount: number;
  visibility: ChatVisibility;
  status?: "ready" | "running" | "attention";
};

/** True for a thread that is visible to the whole workspace, not just its author. */
export function isSharedChat(item: Pick<ChatItem, "visibility">) {
  return item.visibility !== "private";
}
