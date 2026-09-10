import { expect, it } from "vitest";
import {
  resolveContextSourceIds,
  resolveEditSourceIds,
  resolveRefreshSourceIds,
} from "./message-groups";
import type { ChatMessageItem } from "../streaming-assistant-state";

it("send, edit and regenerate preserve an explicitly cleared selection", () => {
  const messages: ChatMessageItem[] = [
    {
      id: "old",
      role: "user",
      content: "",
      contentJson: {},
      parentMessageId: null,
      createdAt: new Date(0).toISOString(),
      metadata: { sourceIds: ["historical"] },
    },
  ];
  expect(resolveContextSourceIds({ messages, activeSourceIds: [] })).toEqual(
    [],
  );
  expect(
    resolveEditSourceIds({
      activeSourceIds: [],
      editingMessageId: "old",
      groups: [],
    }),
  ).toEqual([]);
  expect(
    resolveRefreshSourceIds({
      activeSourceIds: [],
      assistantMessageId: "answer",
      groups: [],
    }),
  ).toEqual([]);
});

it("all new executions use the current explicit selection", () => {
  expect(
    resolveContextSourceIds({ messages: [], activeSourceIds: ["current"] }),
  ).toEqual(["current"]);
  expect(
    resolveEditSourceIds({
      activeSourceIds: ["current"],
      editingMessageId: "old",
      groups: [],
    }),
  ).toEqual(["current"]);
  expect(
    resolveRefreshSourceIds({
      activeSourceIds: ["current"],
      assistantMessageId: "answer",
      groups: [],
    }),
  ).toEqual(["current"]);
});
