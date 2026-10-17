// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, test, vi } from "vitest";
import messages from "../../../../../messages/en.json";
import { MessageList } from "./message-list";
import { AssistantActivityRenderItems } from "./assistant-activity-stack";
import type { MessageVersion, ToolCallRecord } from "./types";

// Scrolling and markdown rendering are unrelated to disclosure behavior.
vi.mock("@sourceweft/ui-web/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ConversationContent: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
  ConversationScrollButton: () => null,
}));
vi.mock("./message-response", () => ({
  CitationAwareMessageResponse: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
}));

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
});

async function renderVersion(
  version: MessageVersion,
  isStreaming = true,
  versions = [version],
) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MessageList
          isStreaming={isStreaming}
          activeVersionByGroup={{ assistant: versions.indexOf(version) }}
          messageGroups={[
            {
              groupId: "assistant",
              role: "assistant",
              latestVersionId: versions.at(-1)!.id,
              versions,
            },
          ]}
        />
      </NextIntlClientProvider>,
    ),
  );
}

function reasoningRows() {
  return [...host.querySelectorAll("button")].filter((button) =>
    /^(Thinking\.\.\.|Thought for)/.test(button.textContent ?? ""),
  );
}

function reasoningRow(index = 0) {
  const row = reasoningRows()[index];
  assert.ok(row, "expected a visible thinking disclosure");
  return row;
}

function toolGroupButton() {
  const button = host.querySelector<HTMLButtonElement>(
    "[data-tool-group] > button",
  );
  assert.ok(button, "expected a grouped tool disclosure");
  return button;
}

function tool(
  id: string,
  status: ToolCallRecord["status"] = "completed",
): ToolCallRecord {
  return {
    id,
    tool: "execute",
    status,
    input: { command: "pwd" },
    output: null,
    error: null,
    latencyMs: 10,
  };
}

function toolBlock(id: string) {
  return { id: `block-${id}`, toolCallId: id, type: "tool" as const };
}

function version(overrides: Partial<MessageVersion> = {}): MessageVersion {
  return {
    id: "message-1",
    content: "",
    threadRun: { status: "running" },
    renderBlocks: [
      {
        id: "reasoning-1",
        type: "reasoning",
        text: "Inspecting the evidence.",
      },
    ],
    ...overrides,
  };
}

test("answer output ends untouched thinking before the run completes", async () => {
  const current = version();
  await renderVersion(current);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
  await renderVersion({
    ...current,
    content: "The answer",
    renderBlocks: [
      ...current.renderBlocks!,
      { id: "answer", type: "text", text: "The answer" },
    ],
  });
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
  assert.match(reasoningRow().textContent ?? "", /^Thought for/);
});

test("manual expansion survives resumed thinking and completion", async () => {
  const current = version({ threadRun: { status: "completed" } });
  await renderVersion(current, false);
  await act(async () => reasoningRow().click());
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
  await renderVersion({ ...current, threadRun: { status: "running" } });
  await renderVersion(current, false);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
});

test("manual collapse survives streamed deltas, a pause, and resumed thinking", async () => {
  const current = version();
  await renderVersion(current);
  await act(async () => reasoningRow().click());
  for (let chunk = 1; chunk <= 3; chunk++) {
    await renderVersion({
      ...current,
      renderBlocks: [
        {
          ...current.renderBlocks![0]!,
          type: "reasoning",
          text: `More detail ${chunk}`,
        },
      ],
    });
    assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
    assert.ok(!host.textContent?.includes(`More detail ${chunk}`));
  }
  await renderVersion({
    ...current,
    threadRun: { status: "waiting_for_approval" },
  });
  await renderVersion(current);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
  assert.match(reasoningRow().textContent ?? "", /^Thinking/);
});

test("manual expansion survives regrouping and tool-group collapse/reopening", async () => {
  const current = version({
    toolCalls: [tool("a")],
    renderBlocks: [toolBlock("a"), ...version().renderBlocks!],
  });
  await renderVersion(current);
  // Explicitly choose open while the automatic streaming default is open.
  await act(async () => reasoningRow().click());
  await act(async () => reasoningRow().click());
  const grouped = {
    ...current,
    toolCalls: [tool("a"), tool("b", "running")],
    renderBlocks: [...current.renderBlocks!, toolBlock("b")],
  };
  await renderVersion(grouped);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
  assert.match(reasoningRow().textContent ?? "", /^Thought for/);
  assert.ok(host.textContent?.includes("Inspecting the evidence."));
  // Finishing the tools must not automatically hide manually expanded thinking.
  const answered = {
    ...grouped,
    content: "Done",
    toolCalls: [tool("a"), tool("b")],
    renderBlocks: [
      ...grouped.renderBlocks,
      { id: "answer", type: "text" as const, text: "Done" },
    ],
    threadRun: { status: "completed" },
  };
  await renderVersion(answered, false);
  assert.equal(toolGroupButton().getAttribute("aria-expanded"), "true");
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
  await act(async () => toolGroupButton().click());
  assert.equal(reasoningRows().length, 0);
  await act(async () => toolGroupButton().click());
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
});

test("manual collapse survives regrouping, group growth, and resumed output", async () => {
  const current = version({
    toolCalls: [tool("a")],
    renderBlocks: [toolBlock("a"), ...version().renderBlocks!],
  });
  await renderVersion(current);
  await act(async () => reasoningRow().click());
  const grouped = {
    ...current,
    toolCalls: [tool("a"), tool("b", "running")],
    renderBlocks: [...current.renderBlocks!, toolBlock("b")],
  };
  await renderVersion(grouped);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
  await act(async () => toolGroupButton().click());
  const grown = {
    ...grouped,
    toolCalls: [tool("a"), tool("b"), tool("c", "running")],
    renderBlocks: [...grouped.renderBlocks, toolBlock("c")],
  };
  await renderVersion(grown);
  assert.equal(toolGroupButton().getAttribute("aria-expanded"), "false");
  await act(async () => toolGroupButton().click());
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
  // Replacing the trailing tools with the same live reasoning also preserves
  // the choice after it moves out of the group and is mounted again.
  await renderVersion(current);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
});

test("a later reasoning block gets its own default without reopening the old block", async () => {
  const current = version();
  await renderVersion(current);
  await act(async () => reasoningRow().click());
  await renderVersion({
    ...current,
    toolCalls: [tool("a")],
    renderBlocks: [
      ...current.renderBlocks!,
      toolBlock("a"),
      {
        id: "reasoning-2",
        type: "reasoning",
        text: "Checking the next result.",
      },
    ],
  });
  assert.equal(reasoningRow(0).getAttribute("aria-expanded"), "false");
  assert.equal(reasoningRow(1).getAttribute("aria-expanded"), "true");
});

test("a manual expansion remains open when answer text starts and continues", async () => {
  const current = version();
  await renderVersion(current);
  await act(async () => reasoningRow().click());
  await act(async () => reasoningRow().click());
  for (const text of ["The", "The answer", "The answer is ready."]) {
    await renderVersion({
      ...current,
      content: text,
      renderBlocks: [
        ...current.renderBlocks!,
        { id: "answer", type: "text", text },
      ],
    });
    assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
    assert.match(reasoningRow().textContent ?? "", /^Thought for/);
  }
});

test("an activity stack with a trailing tool does not mark earlier reasoning as streaming", async () => {
  host = document.createElement("div");
  root = createRoot(host);
  const reasoning = {
    type: "reasoning" as const,
    id: "r",
    key: "r",
    order: 0,
    text: "Previous thought",
  };
  const render = async (hasTool: boolean) => {
    await act(async () =>
      root!.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <AssistantActivityRenderItems
            isStreaming
            items={[
              reasoning,
              ...(hasTool
                ? [
                    {
                      type: "tool" as const,
                      id: "t",
                      key: "t",
                      order: 1,
                      toolCall: tool("t", "running"),
                    },
                  ]
                : []),
            ]}
          />
        </NextIntlClientProvider>,
      ),
    );
  };
  await render(false);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
  await render(true);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
  assert.match(reasoningRow().textContent ?? "", /^Thought for/);
});

test("manual choices are isolated by message version and restored after switching back", async () => {
  const first = version({ threadRun: { status: "completed" } });
  const second = version({
    id: "message-2",
    threadRun: { status: "completed" },
  });
  const versions = [first, second];
  await renderVersion(first, false, versions);
  await act(async () => reasoningRow().click());
  await renderVersion(second, false, versions);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
  await renderVersion(first, false, versions);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
});

test("persisting an optimistic message preserves choices through its stable render key", async () => {
  const current = version({
    id: "temporary",
    renderKey: "stable",
    threadRun: { status: "completed" },
  });
  await renderVersion(current, false);
  await act(async () => reasoningRow().click());
  await renderVersion({ ...current, id: "persisted" }, false);
  assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
});

test.each(["completed", "failed", "cancelled", "waiting_for_approval"])(
  "untouched thinking collapses on %s, while explicit expansion stays open",
  async (status) => {
    const current = version();
    await renderVersion(current);
    const ended = {
      ...current,
      threadRun: { status },
      isError: status === "failed",
      isCancelled: status === "cancelled",
    };
    await renderVersion(ended, false);
    assert.equal(reasoningRow().getAttribute("aria-expanded"), "false");
    assert.match(reasoningRow().textContent ?? "", /^Thought for/);
    await act(async () => reasoningRow().click());
    await renderVersion(current);
    await renderVersion(ended, false);
    assert.equal(reasoningRow().getAttribute("aria-expanded"), "true");
  },
);
