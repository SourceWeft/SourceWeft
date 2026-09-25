// @vitest-environment jsdom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { useThreadVersioning } from "./use-thread-versioning";
import {
  useStreamingAssistantTransientState,
  type ChatMessageItem,
} from "../streaming-assistant-state";
function message(
  id: string,
  role: "user" | "assistant",
  overrides: Partial<ChatMessageItem> = {},
): ChatMessageItem {
  return {
    id,
    role,
    content: id,
    contentJson: {},
    metadata: {},
    parentMessageId: null,
    createdAt: "2026-09-23T00:00:00Z",
    ...overrides,
  };
}
const user = message("user", "user");
const assistant = message("assistant", "assistant", {
  parentMessageId: null,
  metadata: { sourceUserMessageId: "user" },
  createdAt: "2026-09-23T00:00:01Z",
});
const newer = message("newer", "assistant", {
  ...assistant,
  id: "newer",
  parentMessageId: "assistant",
  content: "Newer answer",
  metadata: { ...assistant.metadata, versionOf: "assistant" },
  createdAt: "2026-09-23T00:00:02Z",
});
async function mount(initial: ChatMessageItem[], strict = false) {
  const root = createRoot(document.createElement("div"));
  let versions: ReturnType<typeof useThreadVersioning>;
  let stream: ReturnType<typeof useStreamingAssistantTransientState>;
  let renders = 0;
  let setMessages: (messages: ChatMessageItem[]) => void;
  function Harness() {
    renders++;
    const [messages, set] = useState(initial);
    setMessages = set;
    stream = useStreamingAssistantTransientState();
    versions = useThreadVersioning({
      isStreaming: true,
      messages,
      mergeStreamingAssistantIntoMessages:
        stream.mergeStreamingAssistantIntoMessages,
    });
    return <p>{versions.activeAssistantVersion?.content}</p>;
  }
  await act(async () =>
    root.render(
      strict ? (
        <StrictMode>
          <Harness />
        </StrictMode>
      ) : (
        <Harness />
      ),
    ),
  );
  return {
    get renders() {
      return renders;
    },
    get versions() {
      return versions!;
    },
    get stream() {
      return stream!;
    },
    replace: (messages: ChatMessageItem[]) =>
      act(async () => setMessages(messages)),
    close: () => act(async () => root.unmount()),
  };
}
test("1000 text-only snapshots retain the existing branch selection object", async () => {
  const h = await mount([user, assistant]);
  try {
    const original = h.versions.activeVersionByGroup;
    for (let n = 1; n <= 1000; n++) {
      await act(async () =>
        h.stream.setStreamingAssistantSnapshot({
          message: { ...assistant, content: `Token ${n}` },
          messageId: assistant.id,
          messageIds: [assistant.id],
          renderVersion: n,
        }),
      );
      expect(h.versions.activeVersionByGroup).toBe(original);
    }
    expect(h.versions.activeAssistantVersion?.content).toBe("Token 1000");
    expect(h.renders).toBeLessThanOrEqual(1005);
  } finally {
    await h.close();
  }
});
test.each([false, true])(
  "manual selection survives text updates; new versions select latest; removed groups are cleared (StrictMode %s)",
  async (strict) => {
    const h = await mount([user, assistant, newer], strict);
    try {
      const group = h.versions.messageGroups.find(
        (g) => g.role === "assistant",
      )!;
      expect(h.versions.activeVersionByGroup[group.groupId]).toBe(1);
      await act(async () =>
        h.versions.handleActiveVersionChange({
          groupId: group.groupId,
          branchIndex: 0,
        }),
      );
      const chosen = h.versions.activeVersionByGroup;
      await h.replace([
        user,
        { ...assistant, content: "Updated original text" },
        newer,
      ]);
      expect(h.versions.activeVersionByGroup).toBe(chosen);
      expect(h.versions.activeAssistantVersion?.id).toBe(assistant.id);
      const newest = {
        ...newer,
        id: "newest",
        createdAt: "2026-09-23T00:00:03Z",
      };
      await h.replace([user, assistant, newer, newest]);
      expect(h.versions.activeVersionByGroup[group.groupId]).toBe(2);
      await h.replace([user, assistant]);
      expect(h.versions.activeVersionByGroup[group.groupId]).toBe(0);
      await h.replace([]);
      expect(h.versions.activeVersionByGroup).toEqual({});
    } finally {
      await h.close();
    }
  },
);
test("pending turn selection waits for its assistant and reset drops stale intent", async () => {
  const h = await mount([user, assistant]);
  try {
    const futureUser = message("next-user", "user", {
      createdAt: "2026-09-23T00:00:04Z",
    });
    const futureAssistant = message("next-answer", "assistant", {
      metadata: { sourceUserMessageId: "next-user" },
      parentMessageId: null,
      createdAt: "2026-09-23T00:00:05Z",
    });
    h.versions.pendingLatestVersionSelectionRef.current = {
      userGroupId: "user:next-user",
      assistantGroupId: "assistant:next-answer",
    };
    await h.replace([user, assistant, futureUser]);
    expect(h.versions.pendingLatestVersionSelectionRef.current).not.toBeNull();
    await h.replace([user, assistant, futureUser, futureAssistant]);
    expect(h.versions.pendingLatestVersionSelectionRef.current).toBeNull();
    h.versions.pendingLatestVersionSelectionRef.current = {
      userGroupId: "stale",
      assistantGroupId: undefined,
    };
    await act(async () => h.versions.resetVersioningState());
    expect(h.versions.pendingLatestVersionSelectionRef.current).toBeNull();
    expect(h.versions.activeVersionByGroup).toEqual({});
  } finally {
    await h.close();
  }
});

test("a persisted assistant ID replaces its optimistic group without retaining a stale selection", async () => {
  const h = await mount([user, assistant]);
  try {
    const oldGroup = h.versions.messageGroups.find(
      (group) => group.role === "assistant",
    )!.groupId;
    await act(async () =>
      h.stream.setStreamingAssistantSnapshot({
        message: {
          ...assistant,
          id: "persisted",
          content: "Authoritative response",
        },
        messageId: "persisted",
        messageIds: [assistant.id, "persisted"],
        renderVersion: 1,
      }),
    );
    const group = h.versions.messageGroups.find(
      (item) => item.role === "assistant",
    )!;
    expect(group.versions).toHaveLength(1);
    expect(group.versions[0]?.id).toBe("persisted");
    expect(h.versions.activeVersionByGroup[oldGroup]).toBeUndefined();
    expect(h.versions.activeVersionByGroup[group.groupId]).toBe(0);
  } finally {
    await h.close();
  }
});

test("equivalent fresh message arrays and merge callbacks cannot feed an update loop", async () => {
  const root = createRoot(document.createElement("div"));
  let renders = 0;
  function Parent() {
    if (++renders > 16)
      throw new Error("Version selection feedback did not settle");
    const state = useThreadVersioning({
      isStreaming: true,
      messages: [user, assistant],
      mergeStreamingAssistantIntoMessages: (items) => [...items],
    });
    return <p>{state.activeAssistantVersion?.content}</p>;
  }
  try {
    await act(async () => root.render(<Parent />));
    expect(renders).toBeLessThanOrEqual(4);
  } finally {
    await act(async () => root.unmount());
  }
});
