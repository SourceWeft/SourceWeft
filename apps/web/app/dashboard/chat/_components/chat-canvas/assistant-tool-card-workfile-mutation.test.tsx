// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, test, vi } from "vitest";
import { AssistantToolCard } from "./assistant-tool-card";
import type { ToolCallRecord } from "./types";
import { WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT } from "./workfile-mutation-state";
import { click, mountWithIntl, unmountAll } from "@/test/react";

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
  const { container } = await mountWithIntl(
    createElement(AssistantToolCard, {
      defaultOpen: true,
      onWorkfileClick: input.onWorkfileClick,
      toolCall: input.toolCall,
    }),
  );

  return container;
}

afterEach(unmountAll);

test("AssistantToolCard renders write_file workfile preview and opens workfile", async () => {
  const onWorkfileClick = vi.fn();
  const element = await renderToolCard({
    onWorkfileClick,
    toolCall: toolCall({
      input: {
        content: "console.log('deck');\n",
        path: "/files/ppt/deck.js",
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
  assert.equal(pathInput?.value, "/files/ppt/deck.js");

  const openButton = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "Open Workfile",
  );
  assert.ok(openButton);

  await click(openButton);

  assert.equal(onWorkfileClick.mock.calls.length, 1);
  assert.equal(onWorkfileClick.mock.calls[0]?.[0], "/files/ppt/deck.js");
});

test("AssistantToolCard renders truncated write_file preview", async () => {
  const content = "a".repeat(WORKFILE_MUTATION_PREVIEW_CHAR_LIMIT + 20);
  const element = await renderToolCard({
    toolCall: toolCall({
      input: {
        content,
        path: "/files/ppt/deck.ts",
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
        path: "/files/ppt/deck.js",
        replace_all: true,
      },
      output: {
        occurrences: 2,
        path: "/files/ppt/deck.js",
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

test("AssistantToolCard renders a running write_file's streamed partial code keyed by file_path", async () => {
  // A `tool-input-delta` partial: deepagents' write_file names its path
  // `file_path`, and the call is still being authored.
  const element = await renderToolCard({
    toolCall: toolCall({
      input: {
        content: "def fib(n):\n    a, b = 0",
        file_path: "/files/fib.py",
      },
      latencyMs: null,
      status: "running",
      tool: "write_file",
    }),
  });

  assert.match(element.textContent ?? "", /fib\.py/);
  assert.match(element.textContent ?? "", /def fib\(n\):/);
  assert.match(element.textContent ?? "", /a, b = 0/);
  await unmountAll();

  // Models also emit `content` before the path: the partial code still
  // renders, without a path row, until the path parses.
  const pathless = await renderToolCard({
    toolCall: toolCall({
      input: { content: "def fib(n):\n    a, b = 0" },
      latencyMs: null,
      status: "running",
      tool: "write_file",
    }),
  });
  assert.match(pathless.textContent ?? "", /def fib\(n\):/);
  assert.equal(
    pathless.querySelector('input[aria-label="Workfile path"]'),
    null,
  );
});
