import type { MessageRecord } from "../../content/types";

/**
 * Keep the newest version of every message: an edit or regeneration points
 * `parentMessageId` at the version it replaces, so any message another one
 * names as its parent is superseded. Pure, so callers that must not load the
 * database (the chat export's selection) can use it.
 */
export function collapseSupersededMessages(items: MessageRecord[]) {
  const supersededIds = new Set(
    items
      .map((item) => item.parentMessageId)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
  );

  return items.filter((item) => !supersededIds.has(item.id));
}
