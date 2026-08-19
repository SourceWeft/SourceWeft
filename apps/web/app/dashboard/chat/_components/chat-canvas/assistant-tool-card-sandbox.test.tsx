// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, test, vi } from "vitest";
import { AssistantToolCard } from "./assistant-tool-card";
import type { ToolCallRecord } from "./types";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function toolCall(input: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    error: null,
    id: "sandbox-call-1",
    input: {},
    latencyMs: 120,
    output: null,
    status: "completed",
    tool: "execute",
    ...input,
  };
}

function commandInputValue(element: HTMLElement) {
  // Single-line commands render in a readonly Snippet <input>, whose value is
  // not part of textContent.
  return element.querySelector<HTMLInputElement>(
    'input[aria-label="Sandbox command"]',
  )?.value;
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

test("AssistantToolCard renders execute command and output together", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: { command: "pnpm test" },
      output: {
        exitCode: 1,
        output: "tests failed",
        truncated: true,
      },
    }),
  });

  assert.match(element.textContent ?? "", /Execute sandbox command/);
  assert.equal(commandInputValue(element), "pnpm test");
  assert.match(element.textContent ?? "", /tests failed/);
  assert.match(element.textContent ?? "", /exit 1/);
  assert.match(element.textContent ?? "", /truncated/);
});

test("AssistantToolCard shows the running execute command with pending output", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: { command: "pnpm build" },
      status: "running",
    }),
  });

  assert.match(element.textContent ?? "", /Running/);
  assert.equal(commandInputValue(element), "pnpm build");
  assert.ok(element.querySelector('button[aria-label="Copy sandbox command"]'));
  assert.match(
    element.textContent ?? "",
    /Command is running\. Output will appear/,
  );
});

test("AssistantToolCard renders persisted sandbox operations", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: { command: "printf done" },
      output: {
        exitCode: 0,
        output: "done",
        operations: [
          {
            operationType: "create",
            status: "succeeded",
            durationMs: 80,
            createdAt: "2026-08-16T08:00:00.000Z",
            result: {},
          },
          {
            operationType: "execute",
            status: "succeeded",
            durationMs: 120,
            createdAt: "2026-08-16T08:00:01.000Z",
            result: { exitCode: 0, outputChars: 4 },
          },
        ],
        truncated: false,
      },
    }),
  });

  assert.match(element.textContent ?? "", /Recorded operations/);
  // Collapsed by default — the timeline content is behind the toggle.
  assert.doesNotMatch(element.textContent ?? "", /Created sandbox/);
  const opsToggle = Array.from(element.querySelectorAll("button")).find(
    (button) => (button.textContent ?? "").includes("Recorded operations"),
  );
  assert.ok(opsToggle, "expected a Recorded operations toggle button");
  await act(async () => {
    opsToggle.click();
  });
  assert.match(element.textContent ?? "", /Created sandbox/);
  assert.match(element.textContent ?? "", /Executed command/);
  assert.match(element.textContent ?? "", /Exit code 0 · 4 output chars/);
  assert.match(element.textContent ?? "", /120ms/);
});

test("AssistantToolCard renders recoverable execute preflight failures as errors", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: { command: "cat /workfiles/report.md" },
      output: {
        exitCode: 1,
        output:
          "SANDBOX_EXECUTE_VFS_PATH_DENIED: execute cannot use /workfiles/report.md\nHint: prepare the file first.",
        truncated: false,
      },
    }),
  });

  assert.match(element.textContent ?? "", /Failed/);
  assert.doesNotMatch(element.textContent ?? "", /Completed/);
  assert.match(
    element.textContent ?? "",
    /Execute commands referenced a SourceWeft VFS path/,
  );
  assert.match(element.textContent ?? "", /SANDBOX_EXECUTE_VFS_PATH_DENIED/);
});

test("AssistantToolCard renders prepare as a directional transfer card", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: {
        files: [
          {
            artifactId: "artifact-1",
            sandboxPath: "/workspace/input/image.png",
          },
        ],
      },
      output: {
        files: [
          {
            sandboxPath: "/workspace/input/image.png",
            sizeBytes: 1024,
            sourcePath: "artifact:artifact-1",
          },
        ],
        ok: true,
        totalBytes: 1024,
      },
      tool: "prepare_sandbox_workspace",
    }),
  });

  assert.match(element.textContent ?? "", /Prepare sandbox workspace/);
  assert.match(element.textContent ?? "", /artifact:artifact-1/);
  assert.match(element.textContent ?? "", /\/workspace\/input\/image\.png/);
  assert.match(element.textContent ?? "", /1 KiB/);
});

test("AssistantToolCard labels unfinished transfer mappings as planned", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: {
        files: [
          {
            sourcePath: "/workfiles/report.md",
            sandboxPath: "/workspace/input/report.md",
          },
        ],
      },
      status: "running",
      tool: "prepare_sandbox_workspace",
    }),
  });

  assert.match(element.textContent ?? "", /1 planned file/);
  assert.match(element.textContent ?? "", /Running/);
});

test("AssistantToolCard opens collected Workfiles from transfer targets", async () => {
  const onWorkfileClick = vi.fn();
  const element = await renderToolCard({
    onWorkfileClick,
    toolCall: toolCall({
      input: {
        outputs: [
          {
            sandboxPath: "/workspace/output/report.md",
            target: { kind: "workfile", path: "/workfiles/report.md" },
          },
        ],
      },
      output: {
        ok: true,
        outputs: [
          {
            sandboxPath: "/workspace/output/report.md",
            sizeBytes: 512,
            targetPath: "/workfiles/report.md",
          },
        ],
        totalBytes: 512,
      },
      tool: "collect_sandbox_outputs",
    }),
  });

  const targetButton = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "/workfiles/report.md",
  );
  assert.ok(targetButton);

  await act(async () => {
    targetButton.click();
  });

  assert.equal(onWorkfileClick.mock.calls.length, 1);
  assert.equal(onWorkfileClick.mock.calls[0]?.[0], "/workfiles/report.md");
});

test("AssistantToolCard does not open planned Workfile targets", async () => {
  const onWorkfileClick = vi.fn();
  const element = await renderToolCard({
    onWorkfileClick,
    toolCall: toolCall({
      input: {
        outputs: [
          {
            sandboxPath: "/workspace/output/report.md",
            target: { kind: "workfile", path: "/workfiles/report.md" },
          },
        ],
      },
      status: "running",
      tool: "collect_sandbox_outputs",
    }),
  });

  assert.match(element.textContent ?? "", /1 planned file/);
  assert.equal(
    [...element.querySelectorAll("button")].some(
      (button) => button.textContent === "/workfiles/report.md",
    ),
    false,
  );
  assert.equal(onWorkfileClick.mock.calls.length, 0);
});

test("AssistantToolCard uses safe messages for transfer failures", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      input: {
        outputs: [
          {
            sandboxPath: "/workspace/output/report.md",
            target: { kind: "workfile", path: "/workfiles/report.md" },
          },
        ],
      },
      output: {
        code: "SANDBOX_COLLECT_CONFLICT",
        message: "SANDBOX_COLLECT_CONFLICT: internal storage detail",
        ok: false,
        recoverable: true,
        status: "failed",
      },
      tool: "collect_sandbox_outputs",
    }),
  });

  assert.match(element.textContent ?? "", /Failed/);
  assert.match(
    element.textContent ?? "",
    /A target \/workfiles file already exists/,
  );
  assert.doesNotMatch(element.textContent ?? "", /internal storage detail/);
});

test("AssistantToolCard renders denied execute calls with the command", async () => {
  const element = await renderToolCard({
    toolCall: toolCall({
      approvalState: "rejected",
      input: { command: "curl https://example.com" },
    }),
  });

  assert.match(element.textContent ?? "", /Rejected/);
  assert.equal(commandInputValue(element), "curl https://example.com");
  assert.ok(element.querySelector('button[aria-label="Copy sandbox command"]'));
});
