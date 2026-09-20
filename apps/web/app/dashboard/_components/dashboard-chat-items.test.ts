import assert from "node:assert/strict";
import { test } from "vitest";
import {
  findChatItem,
  flattenChatItems,
  insertChildChatItem,
  mapChatItems,
  mapThreadToChatItem,
  removeChatItem,
} from "./dashboard-chat-items";
import type { ChatItem } from "./dashboard-chat-types";

const thread = {
  title: "Proofs",
  sourceCount: 2,
  visibility: "workspace" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  lastMessageAt: null,
};

function chat(id: string, extra: Partial<ChatItem> = {}): ChatItem {
  return {
    id,
    title: id,
    updatedAt: "2026-09-01T00:00:00.000Z",
    sourceCount: 0,
    visibility: "private",
    status: "ready",
    parentThreadId: null,
    personaId: null,
    ...extra,
  };
}

test("mapThreadToChatItem carries nesting fields and maps one level of children", () => {
  const item = mapThreadToChatItem({
    ...thread,
    id: "parent",
    children: [
      {
        ...thread,
        id: "child",
        title: "验证体 D",
        parentThreadId: "parent",
        personaId: "explore",
        children: [{ ...thread, id: "grandchild", parentThreadId: "child" }],
      },
    ],
  });

  assert.equal(item.parentThreadId, null);
  assert.equal(item.personaId, null);
  assert.equal(item.children?.length, 1);
  const child = item.children?.[0];
  assert.equal(child?.id, "child");
  assert.equal(child?.parentThreadId, "parent");
  assert.equal(child?.personaId, "explore");
  assert.equal(child?.status, "ready");
  assert.equal(child && "children" in child, false);
});

test("mapThreadToChatItem leaves the children key unset for a single-thread response", () => {
  const item = mapThreadToChatItem({ ...thread, id: "solo" });
  assert.equal("children" in item, false);
  assert.equal(item.parentThreadId, null);
  assert.equal(item.personaId, null);
  // Spreading a refreshed record over a list item keeps the children it shows.
  const merged = { ...chat("solo", { children: [chat("kid")] }), ...item };
  assert.equal(merged.children?.length, 1);
});

test("findChatItem, mapChatItems and removeChatItem reach nested children", () => {
  const items = [
    chat("a", { children: [chat("a1", { parentThreadId: "a" })] }),
    chat("b"),
  ];

  assert.equal(findChatItem(items, "a1")?.parentThreadId, "a");
  assert.equal(findChatItem(items, "b")?.id, "b");
  assert.equal(findChatItem(items, "zzz"), undefined);

  const retitled = mapChatItems(items, (item) =>
    item.id === "a1" ? { ...item, title: "Renamed" } : item,
  );
  assert.equal(retitled[0]?.children?.[0]?.title, "Renamed");
  assert.equal(retitled[1]?.title, "b");

  const withoutChild = removeChatItem(items, "a1");
  assert.deepEqual(withoutChild[0]?.children, []);
  assert.equal(withoutChild.length, 2);
  assert.equal(removeChatItem(items, "b").length, 1);
});

test("insertChildChatItem nests under a loaded parent and reports a missing one", () => {
  const items = [
    chat("a", { children: [chat("old", { parentThreadId: "a" })] }),
  ];
  const child = chat("new", { parentThreadId: "a" });

  const nested = insertChildChatItem(items, child);
  assert.deepEqual(
    nested?.[0]?.children?.map((item) => item.id),
    ["new", "old"],
  );
  // Re-inserting replaces the earlier copy instead of duplicating it.
  assert.equal(
    insertChildChatItem(nested ?? [], child)?.[0]?.children?.length,
    2,
  );
  assert.equal(
    insertChildChatItem(items, chat("orphan", { parentThreadId: "gone" })),
    null,
  );
  assert.equal(insertChildChatItem(items, chat("top")), null);
});

test("flattenChatItems lists parents followed by their children", () => {
  const items = [
    chat("a", { children: [chat("a1", { parentThreadId: "a" })] }),
    chat("b"),
  ];
  assert.deepEqual(
    flattenChatItems(items).map((item) => item.id),
    ["a", "a1", "b"],
  );
});
