import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getSandboxCollectedWorkfilePaths,
  getSandboxToolOperationTimeline,
  getSandboxToolResultDetails,
  getSandboxToolResultSummary,
  getSandboxToolSafeErrorMessage,
  parseSandboxToolResultDisplay,
} from "./sandbox-tool-result-display";

test("parses sandbox prepare result JSON", () => {
  assert.deepEqual(
    parseSandboxToolResultDisplay(
      JSON.stringify({
        ok: true,
        totalBytes: 3072,
        files: [
          {
            sourcePath: "/work/input.md",
            sandboxPath: "/workspace/input/input.md",
          },
          {
            sourcePath: "/work/data.csv",
            sandboxPath: "/workspace/input/data.csv",
          },
        ],
      }),
    ),
    {
      ok: true,
      output: null,
      totalBytes: 3072,
      filePaths: ["/workspace/input/input.md", "/workspace/input/data.csv"],
      outputPaths: [],
      truncated: null,
      exitCode: null,
    },
  );
});

test("parses sandbox collect result JSON", () => {
  assert.deepEqual(
    parseSandboxToolResultDisplay(
      JSON.stringify({
        ok: true,
        totalBytes: 4096,
        outputs: [
          {
            sandboxPath: "/workspace/output/report.md",
            target: { path: "/work/report.md" },
          },
          {
            sandboxPath: "/workspace/output/chart.png",
            targetPath: "/work/chart.png",
          },
        ],
      }),
    ),
    {
      ok: true,
      output: null,
      totalBytes: 4096,
      filePaths: [],
      outputPaths: ["/work/report.md", "/work/chart.png"],
      truncated: null,
      exitCode: null,
    },
  );
});

test("parses sandbox execution metadata when present", () => {
  assert.deepEqual(
    parseSandboxToolResultDisplay(
      JSON.stringify({
        ok: false,
        output: "command failed",
        truncated: true,
        exitCode: 2,
      }),
    ),
    {
      ok: false,
      output: "command failed",
      totalBytes: null,
      filePaths: [],
      outputPaths: [],
      truncated: true,
      exitCode: 2,
    },
  );
});

test("returns null for malformed or non-object sandbox result JSON", () => {
  assert.equal(parseSandboxToolResultDisplay("{"), null);
  assert.equal(parseSandboxToolResultDisplay("null"), null);
  assert.equal(parseSandboxToolResultDisplay("[]"), null);
});

test("summarizes sandbox prepare results for tool cards", () => {
  assert.equal(
    getSandboxToolResultSummary({
      toolName: "prepare_sandbox_workspace",
      output: JSON.stringify({
        ok: true,
        totalBytes: 2048,
        files: [
          { sandboxPath: "/workspace/input/a.md" },
          { sandboxPath: "/workspace/input/b.md" },
        ],
      }),
    }),
    "Prepared 2 files · 2 KiB · /workspace/input/a.md, /workspace/input/b.md",
  );
});

test("formats sandbox prepare operation details for tool cards", () => {
  assert.deepEqual(
    getSandboxToolResultDetails({
      toolName: "prepare_sandbox_workspace",
      output: {
        ok: true,
        totalBytes: 2048,
        files: [
          { sandboxPath: "/workspace/input/a.md" },
          { sandboxPath: "/workspace/input/b.md" },
        ],
      },
    }),
    [
      { label: "Operation", value: "Prepared sandbox workspace" },
      { label: "Inputs", value: "2 files" },
      { label: "Size", value: "2 KiB" },
      {
        label: "Input paths",
        value: "/workspace/input/a.md, /workspace/input/b.md",
      },
    ],
  );
});

test("summarizes sandbox collect results for tool cards", () => {
  assert.equal(
    getSandboxToolResultSummary({
      toolName: "collect_sandbox_outputs",
      output: {
        ok: true,
        totalBytes: 512,
        outputs: [
          { target: { path: "/work/report.md" } },
          { targetPath: "/work/chart.csv" },
        ],
      },
    }),
    "Collected 2 outputs · 512 B · /work/report.md, /work/chart.csv",
  );
});

test("formats sandbox collect operation details for tool cards", () => {
  assert.deepEqual(
    getSandboxToolResultDetails({
      toolName: "collect_sandbox_outputs",
      output: {
        ok: true,
        totalBytes: 512,
        outputs: [
          { target: { path: "/work/report.md" } },
          { targetPath: "/work/chart.csv" },
        ],
      },
    }),
    [
      { label: "Operation", value: "Collected sandbox outputs" },
      { label: "Outputs", value: "2 files" },
      { label: "Size", value: "512 B" },
      { label: "Output paths", value: "/work/report.md, /work/chart.csv" },
    ],
  );
});

test("extracts unique collected /work paths for clickable tool-card links", () => {
  assert.deepEqual(
    getSandboxCollectedWorkfilePaths({
      toolName: "collect_sandbox_outputs",
      output: {
        ok: true,
        outputs: [
          { target: { path: "/work/report.md" } },
          { targetPath: "/work/report.md" },
          { targetPath: "/workspace/output/internal.txt" },
          { targetPath: "/work/charts/summary.csv" },
        ],
      },
    }),
    ["/work/report.md", "/work/charts/summary.csv"],
  );
});

test("does not extract collected workfile links for non-collect tools", () => {
  assert.deepEqual(
    getSandboxCollectedWorkfilePaths({
      toolName: "execute",
      output: {
        ok: true,
        outputs: [{ targetPath: "/work/report.md" }],
      },
    }),
    [],
  );
});

test("summarizes sandbox execute metadata and output for tool cards", () => {
  assert.equal(
    getSandboxToolResultSummary({
      toolName: "execute",
      output: {
        output: "npm test failed",
        exitCode: 1,
        truncated: true,
      },
    }),
    "Exit code 1 · Output truncated · npm test failed",
  );
});

test("formats sandbox execute operation details for tool cards", () => {
  assert.deepEqual(
    getSandboxToolResultDetails({
      toolName: "execute",
      output: {
        output: "npm test failed",
        exitCode: 1,
        truncated: true,
      },
    }),
    [
      { label: "Operation", value: "Executed sandbox command" },
      { label: "Exit code", value: "1" },
      { label: "Output", value: "Truncated" },
    ],
  );
});

test("does not format details for non-sandbox tool results", () => {
  assert.deepEqual(
    getSandboxToolResultDetails({
      toolName: "read",
      output: { ok: true },
    }),
    [],
  );
});

test("formats sandbox operation timeline for tool cards", () => {
  assert.deepEqual(
    getSandboxToolOperationTimeline({
      toolName: "execute",
      output: {
        ok: true,
        timeline: [
          {
            operationType: "create",
            status: "succeeded",
            durationMs: 120,
            summary: "Sandbox ready",
          },
          {
            operationType: "execute",
            status: "failed",
            durationMs: 1530,
            result: { exitCode: 2, outputChars: 42 },
          },
        ],
      },
    }),
    [
      {
        key: "0-create",
        label: "Created sandbox",
        status: "succeeded",
        detail: "Sandbox ready",
        duration: "120ms",
        timestamp: null,
      },
      {
        key: "1-execute",
        label: "Executed command",
        status: "failed",
        detail: "Exit code 2 · 42 output chars",
        duration: "1.5s",
        timestamp: null,
      },
    ],
  );
});

test("formats sandbox operations array as operation timeline", () => {
  assert.deepEqual(
    getSandboxToolOperationTimeline({
      toolName: "collect_sandbox_outputs",
      output: {
        operations: [
          {
            type: "prepare",
            status: "succeeded",
            result: {
              files: [{ sandboxPath: "/workspace/input/a.md" }],
              totalBytes: 2048,
            },
          },
          {
            type: "collect",
            status: "succeeded",
            result: {
              outputs: [{ targetPath: "/work/report.md" }],
              totalBytes: 512,
            },
          },
        ],
      },
    }).map(({ label, detail }) => ({ label, detail })),
    [
      { label: "Prepared workspace", detail: "1 file · 2 KiB" },
      { label: "Collected outputs", detail: "1 output · 512 B" },
    ],
  );
});

test("does not format malformed or non-sandbox operation timelines", () => {
  assert.deepEqual(
    getSandboxToolOperationTimeline({
      toolName: "execute",
      output: { timeline: "not-an-array" },
    }),
    [],
  );
  assert.deepEqual(
    getSandboxToolOperationTimeline({
      toolName: "read",
      output: { timeline: [{ operationType: "execute" }] },
    }),
    [],
  );
});

test("does not summarize non-sandbox tool results", () => {
  assert.equal(
    getSandboxToolResultSummary({
      toolName: "read",
      output: JSON.stringify({
        ok: true,
        files: [{ sandboxPath: "/workspace/a" }],
      }),
    }),
    null,
  );
});

test("maps sandbox transfer errors to user-safe messages", () => {
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "collect_sandbox_outputs",
      error:
        "SANDBOX_COLLECT_CONFLICT: /work/report.md already exists. Set overwrite=true or choose a new path.",
    }),
    "A target /work file already exists. Choose a different destination or approve the operation again with overwrite enabled.",
  );
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "prepare_sandbox_workspace",
      error: "SANDBOX_TOTAL_SIZE_EXCEEDED: prepared files exceed total limit.",
    }),
    "The selected files exceed the total sandbox transfer limit. Reduce the number or size of files and try again.",
  );
});

test("maps sandbox credential and timeout errors to user-safe messages", () => {
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "execute",
      error:
        "SANDBOX_COMMAND_TIMEOUT: sandbox command exceeded the configured timeout.",
    }),
    "The sandbox command exceeded the configured timeout. Try a shorter command or split the work into smaller steps.",
  );
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "execute",
      error: "SANDBOX_PROVIDER_AUTH_FAILED: sandbox credentials failed.",
    }),
    "Sandbox credentials were rejected. Ask an operator to check the backend sandbox credentials.",
  );
});

test("keeps non-sandbox tool errors unchanged", () => {
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "read",
      error: "raw connector error",
    }),
    "raw connector error",
  );
});
