import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatItem } from "./dashboard-chat-types";
import { getSidebarChatItems } from "./dashboard-sidebar-chat-list";

const chat = (
  id: string,
  visibility: ChatItem["visibility"],
  minute: number,
  origin?: ChatItem["origin"],
): ChatItem => ({
  ...(origin ? { origin } : {}),
  id,
  title: id,
  visibility,
  sourceCount: 1,
  updatedAt: new Date(Date.UTC(2026, 8, 10, 0, minute)).toISOString(),
});

const input = {
  privateChats: [
    chat("private-new", "private", 5),
    chat("private-old", "private", 1),
  ],
  sharedChats: [
    chat("workspace", "workspace", 4),
    chat("link", "public_link", 2),
  ],
  archivedChats: [
    chat("archived-private", "private", 6),
    chat("archived-shared", "workspace", 3),
  ],
  filter: "all" as const,
};

test("merges visibility buckets in recent-update order without mutating source lists", () => {
  const before = structuredClone(input);
  assert.deepEqual(
    getSidebarChatItems(input).map((item) => item.id),
    ["private-new", "workspace", "link", "private-old"],
  );
  assert.deepEqual(input, before);
});

test("shared includes workspace and public-link chats; private excludes both", () => {
  assert.deepEqual(
    getSidebarChatItems({ ...input, filter: "shared" }).map((item) => item.id),
    ["workspace", "link"],
  );
  assert.deepEqual(
    getSidebarChatItems({ ...input, filter: "private" }).map((item) => item.id),
    ["private-new", "private-old"],
  );
});

test("archived chats stay isolated even when another loaded page contains the same chat", () => {
  const reloaded = {
    ...input,
    privateChats: [...input.privateChats, input.archivedChats[0]!],
  };
  assert.equal(
    getSidebarChatItems(reloaded).some(
      (item) => item.id === "archived-private",
    ),
    false,
  );
  assert.deepEqual(
    getSidebarChatItems({ ...reloaded, filter: "archived" }).map(
      (item) => item.id,
    ),
    ["archived-private", "archived-shared"],
  );
});

test("a repeated chat uses its newest visibility before filtering", () => {
  const changed = {
    ...input,
    sharedChats: [...input.sharedChats, chat("private-new", "workspace", 7)],
  };
  assert.deepEqual(
    getSidebarChatItems(changed).map((item) => item.id),
    ["private-new", "workspace", "link", "private-old"],
  );
  assert.deepEqual(
    getSidebarChatItems({ ...changed, filter: "private" }).map(
      (item) => item.id,
    ),
    ["private-old"],
  );
});

test("later pages are merged into the current shared filter in update order", () => {
  const nextPage = {
    ...input,
    sharedChats: [...input.sharedChats, chat("older-shared", "workspace", 0)],
  };
  assert.deepEqual(
    getSidebarChatItems({ ...nextPage, filter: "shared" }).map(
      (item) => item.id,
    ),
    ["workspace", "link", "older-shared"],
  );
  assert.deepEqual(
    getSidebarChatItems({
      ...input,
      privateChats: [],
      sharedChats: [],
      filter: "shared",
    }),
    [],
  );
});

test("the scheduled filter keeps only the conversations a task run created", () => {
  const filtered = getSidebarChatItems({
    ...input,
    privateChats: [
      chat("run-1", "private", 7, "scheduled"),
      chat("ordinary", "private", 5, "user"),
    ],
    sharedChats: [chat("run-2", "workspace", 8, "scheduled")],
    filter: "scheduled",
  });
  assert.deepEqual(
    filtered.map((item) => item.id),
    ["run-2", "run-1"],
  );
});

test("the assistant filter keeps only assistant ticket conversations", () => {
  const filtered = getSidebarChatItems({
    ...input,
    privateChats: [
      chat("ticket-1", "private", 7, "assistant_ticket"),
      chat("ordinary", "private", 5, "user"),
      chat("run", "private", 4, "scheduled"),
    ],
    sharedChats: [
      chat("ticket-2", "workspace", 8, "assistant_ticket"),
      // The Router's own conversation is a work log, never a listed ticket.
      chat("router", "workspace", 9, "assistant_router"),
    ],
    filter: "assistant",
  });
  assert.deepEqual(
    filtered.map((item) => item.id),
    ["ticket-2", "ticket-1"],
  );
});
