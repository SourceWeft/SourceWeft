// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, test } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { AssistantWorkflowBlock } from "./assistant-render-segments";
import type { WorkflowBlockEntry } from "./subagent-grouping";
import type { ToolCallRecord } from "./types";
import { WorkflowToolGroup } from "./workflow-tool-group";
import messages from "../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function toolCall(
  id: string,
  tool: string,
  input: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return {
    error: null,
    id,
    input: {},
    latencyMs: 10,
    output: null,
    status: "completed",
    tool,
    ...input,
  };
}

function entriesFor(calls: ToolCallRecord[]): WorkflowBlockEntry[] {
  return calls.map((call, index) => ({
    block: {
      id: `block-${call.id}`,
      toolCallId: call.id,
      type: "tool",
    } as AssistantWorkflowBlock,
    index,
  }));
}

async function renderGroup(input: {
  calls: ToolCallRecord[];
  isRunning?: boolean;
}) {
  const byBlockId = new Map(
    input.calls.map((call) => [`block-${call.id}`, call] as const),
  );
  const element = document.createElement("div");
  document.body.append(element);
  container = element;
  const createdRoot = createRoot(element);
  root = createdRoot;
  const render = async (calls: ToolCallRecord[], isRunning: boolean) => {
    for (const call of calls) byBlockId.set(`block-${call.id}`, call);
    await act(async () => {
      createdRoot.render(
        <NextIntlClientProvider locale="en" messages={intlMessages}>
          <WorkflowToolGroup
            entries={entriesFor(calls)}
            isRunning={isRunning}
            renderEntry={(entry) => (
              <span data-entry={entry.block.id}>{entry.block.id}</span>
            )}
            resolveToolCall={(entry) => byBlockId.get(entry.block.id)}
          />
        </NextIntlClientProvider>,
      );
    });
  };
  await render(input.calls, input.isRunning ?? false);
  return { element, rerender: render };
}

function header(element: HTMLElement) {
  const button = element.querySelector("button");
  assert.ok(button);
  return button;
}

function renderedEntries(element: HTMLElement) {
  return [...element.querySelectorAll("[data-entry]")].map(
    (node) => node.getAttribute("data-entry"),
  );
}

test("a finished run collapses to its summary and expands on click", async () => {
  const { element } = await renderGroup({
    calls: [
      toolCall("a", "search_gmail_messages"),
      toolCall("b", "read_file", { input: { file_path: "/a.ts" } }),
      toolCall("c", "execute"),
    ],
  });

  assert.equal(
    header(element).textContent,
    "Used Gmail, read a file, and ran a command",
  );
  assert.equal(header(element).getAttribute("aria-expanded"), "false");
  assert.deepEqual(renderedEntries(element), []);

  await act(async () => {
    header(element).click();
  });
  assert.equal(header(element).getAttribute("aria-expanded"), "true");
  assert.deepEqual(renderedEntries(element), [
    "block-a",
    "block-b",
    "block-c",
  ]);
});

test("a live run stays open and names the running call", async () => {
  const { element } = await renderGroup({
    calls: [
      toolCall("a", "execute"),
      toolCall("b", "execute", {
        input: { command: "pnpm test" },
        status: "running",
      }),
    ],
    isRunning: true,
  });

  assert.equal(header(element).getAttribute("aria-expanded"), "true");
  assert.notEqual(header(element).textContent, "Ran 2 commands");
  assert.deepEqual(renderedEntries(element), ["block-a", "block-b"]);
});

test("the group folds once the run finishes", async () => {
  const { element, rerender } = await renderGroup({
    calls: [
      toolCall("a", "execute"),
      toolCall("b", "execute", { status: "running" }),
    ],
    isRunning: true,
  });
  assert.equal(header(element).getAttribute("aria-expanded"), "true");

  await rerender(
    [toolCall("a", "execute"), toolCall("b", "execute")],
    false,
  );
  assert.equal(header(element).getAttribute("aria-expanded"), "false");
  assert.equal(header(element).textContent, "Ran 2 commands");
});

test("failures keep the group open and are counted in the header", async () => {
  const { element } = await renderGroup({
    calls: [
      toolCall("a", "execute"),
      toolCall("b", "execute", { error: "boom", status: "error" }),
    ],
  });

  assert.equal(header(element).getAttribute("aria-expanded"), "true");
  assert.match(header(element).textContent ?? "", /Ran 2 commands· 1 failed/);
});
