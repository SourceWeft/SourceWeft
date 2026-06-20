// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, test, vi } from "vitest";
import { AssistantToolCard } from "./assistant-tool-card";
import type { ToolCallRecord } from "./types";
import { WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT } from "./workfile-mutation-state";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function toolCall(input: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    error: null,
    id: "call-1",
    input: {},
    latencyMs: 10,
    output: null,
    status: "completed",
    tool: "write_file",
    ...input,
  };
}

async function renderToolCard(input: {
  onWorkfileClick?: (path: string) => void;
  toolCall: ToolCallRecord;
}) {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;

  await act(async () => {
    createdRoot.render(
      createElement(AssistantToolCard, {
        defaultOpen: true,
        onWorkfileClick: input.onWorkfileClick,
        toolCall: input.toolCall,
      }),
    );
  });

  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("AssistantToolCard renders write_file workfile preview and opens workfile", async () => {
  const onWorkfileClick = vi.fn();
  const element = await renderToolCard({
    onWorkfileClick,
    toolCall: toolCall({
      input: {
        content: "console.log('deck');\n",
        path: "/workfiles/ppt/deck.js",
      },
      tool: "write_file",
    }),
  });

  assert.match(element.textContent ?? "", /Wrote Workfile: deck\.js/);
  assert.match(element.textContent ?? "", /2 lines · 21 B/);
  assert.match(element.textContent ?? "", /deck\.js/);
  assert.match(element.textContent ?? "", /console\.log\('deck'\);/);

  const pathInput = element.querySelector<HTMLInputElement>(
    'input[aria-label="Workfile path"]',
  );
  assert.equal(pathInput?.value, "/workfiles/ppt/deck.js");

  const openButton = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "Open Workfile",
  );
  assert.ok(openButton);

  await act(async () => {
    openButton.click();
  });

  assert.equal(onWorkfileClick.mock.calls.length, 1);
  assert.equal(onWorkfileClick.mock.calls[0]?.[0], "/workfiles/ppt/deck.js");
});

test("AssistantToolCard renders truncated write_file preview", async () => {
  const content = "a".repeat(WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT + 20);
  const element = await renderToolCard({
    toolCall: toolCall({
      input: {
        content,
        path: "/workfiles/ppt/deck.ts",
      },
      tool: "write_file",
    }),
  });

  assert.match(
    element.textContent ?? "",
    /Preview truncated to 8,000 characters\./,
  );
});

test("AssistantToolCard renders edit_file workfile diff preview", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: {
        newString: "const title = 'New';",
        oldString: "const title = 'Old';",
        path: "/workfiles/ppt/deck.js",
        replace_all: true,
      },
      output: {
        occurrences: 2,
        path: "/workfiles/ppt/deck.js",
      },
      tool: "edit_file",
    }),
  });

  assert.match(element.textContent ?? "", /Edited Workfile: deck\.js/);
  assert.match(element.textContent ?? "", /2 replacements · replace_all=true/);
  assert.match(element.textContent ?? "", /--- deck\.js/);
  assert.match(element.textContent ?? "", /\+\+\+ deck\.js/);
  assert.match(element.textContent ?? "", /-const title = 'Old';/);
  assert.match(element.textContent ?? "", /\+const title = 'New';/);
});
