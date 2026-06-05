import type { AssistantActivityItem } from "./assistant-activity-items";

export type AssistantActivityRenderItem =
  | AssistantActivityItem
  | {
      header: Extract<AssistantActivityItem, { type: "tool" }>;
      items: AssistantActivityItem[];
      key: string;
      type: "tool-group";
    };

function isToolRelatedActivityItem(item: AssistantActivityItem) {
  if (item.type === "tool") {
    return true;
  }
  if (item.type === "step") {
    return typeof item.toolCallId === "string" && item.toolCallId.length > 0;
  }
  if (item.type === "reasoning") {
    return typeof item.toolCallId === "string" && item.toolCallId.length > 0;
  }
  return false;
}

export function groupConsecutiveToolItems(
  items: AssistantActivityItem[],
): AssistantActivityRenderItem[] {
  const grouped: AssistantActivityRenderItem[] = [];
  let pendingItems: AssistantActivityItem[] = [];

  const flushToolRelatedItems = () => {
    if (pendingItems.length === 0) {
      return;
    }
    const header = pendingItems.find(
      (item): item is Extract<AssistantActivityItem, { type: "tool" }> =>
        item.type === "tool",
    );
    if (!header) {
      grouped.push(...pendingItems);
    } else {
      grouped.push({
        header,
        items: pendingItems.filter((item) => item.key !== header.key),
        key: `tool-group:${pendingItems.map((item) => item.key).join(":")}`,
        type: "tool-group",
      });
    }
    pendingItems = [];
  };

  for (const item of items) {
    if (isToolRelatedActivityItem(item)) {
      pendingItems.push(item);
      continue;
    }
    flushToolRelatedItems();
    grouped.push(item);
  }

  flushToolRelatedItems();
  return grouped;
}
