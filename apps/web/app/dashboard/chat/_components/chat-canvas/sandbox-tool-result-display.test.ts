import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getSandboxCollectedWorkfilePaths,
  getSandboxToolOperationTimeline,
  getSandboxToolResultDetails,
  getSandboxToolResultSummary,
  getSandboxToolSafeErrorMessage,
  isSandboxToolResultFailure,
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
            sourcePath: "/workfiles/input.md",
            sandboxPath: "/workspace/input/input.md",
          },
          {
            sourcePath: "/workfiles/data.csv",
            sandboxPath: "/workspace/input/data.csv",
          },
        ],
      }),
    ),
    {
      code: null,
      message: null,
      ok: true,
      output: null,
      recoverable: null,
      status: null,
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
            target: { path: "/workfiles/report.md" },
          },
          {
            sandboxPath: "/workspace/output/chart.png",
            targetPath: "/workfiles/chart.png",
          },
        ],
      }),
    ),
    {
      code: null,
      message: null,
      ok: true,
      output: null,
      recoverable: null,
      status: null,
      totalBytes: 4096,
      filePaths: [],
      outputPaths: ["/workfiles/report.md", "/workfiles/chart.png"],
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
      code: null,
      message: null,
      ok: false,
      output: "command failed",
      recoverable: null,
      status: null,
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

test("summarizes sandbox prepare recoverable failures for tool cards", () => {
  assert.equal(
    getSandboxToolResultSummary({
      toolName: "prepare_sandbox_workspace",
      output: {
        ok: false,
        type: "sandbox_prepare_error",
        status: "failed",
        code: "ENOENT",
        message: "ENOENT: no such file",
        recoverable: true,
      },
    }),
    "Failed · ENOENT · ENOENT: no such file",
  );
});

test("detects sandbox result-level failures", () => {
  assert.equal(
    isSandboxToolResultFailure({
      toolName: "prepare_sandbox_workspace",
      output: {
        ok: false,
        status: "failed",
        message: "failed",
      },
    }),
    true,
  );
  assert.equal(
    isSandboxToolResultFailure({
      toolName: "prepare_sandbox_workspace",
      output: { ok: true },
    }),
    false,
  );
  assert.equal(
    isSandboxToolResultFailure({
      toolName: "read_file",
      output: { ok: false },
    }),
    false,
  );
});

test("formats sandbox prepare operation details for tool cards", () => {
  assert.deepEqual(
    getSandboxToolResultDetails({
      toolName: "prepare_sandbox_workspace",
      input: {
        files: [
          {
            sourcePath: "/workfiles/a.md",
            sandboxPath: "/workspace/input/a.md",
          },
          {
            sourcePath: "/workfiles/b.md",
            sandboxPath: "/workspace/input/b.md",
          },
        ],
      },
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
      {
        label: "Requested transfer",
        value:
          "/workfiles/a.md -> /workspace/input/a.md, /workfiles/b.md -> /workspace/input/b.md",
      },
    ],
  );
});

test("formats sandbox prepare recoverable failure details for tool cards", () => {
  assert.deepEqual(
    getSandboxToolResultDetails({
      toolName: "prepare_sandbox_workspace",
      input: {
        files: [
          {
            sourcePath: "/workfiles/missing.md",
            sandboxPath: "/workspace/input/missing.md",
          },
        ],
      },
      output: {
        ok: false,
        type: "sandbox_prepare_error",
        status: "failed",
        code: "ENOENT",
        message: "ENOENT: no such file",
        recoverable: true,
      },
    }),
    [
      { label: "Operation", value: "Prepared sandbox workspace" },
      { label: "Status", value: "Failed" },
      { label: "Code", value: "ENOENT" },
      { label: "Message", value: "ENOENT: no such file" },
      { label: "Recoverable", value: "Yes" },
      { label: "Inputs", value: "1 file" },
      {
        label: "Requested transfer",
        value: "/workfiles/missing.md -> /workspace/input/missing.md",
      },
    ],
  );
});

test("formats sandbox prepare request details when execution fails before result files exist", () => {
  assert.deepEqual(
    getSandboxToolResultDetails({
      toolName: "prepare_sandbox_workspace",
      input: {
        files: [
          {
            sourcePath: "/workspace/input/wrong.md",
            sandboxPath: "/workspace/input/wrong.md",
          },
        ],
      },
      output: {},
    }),
    [
      { label: "Operation", value: "Prepared sandbox workspace" },
      { label: "Inputs", value: "1 file" },
      {
        label: "Requested transfer",
        value: "/workspace/input/wrong.md -> /workspace/input/wrong.md",
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
          { target: { path: "/workfiles/report.md" } },
          { targetPath: "/workfiles/chart.csv" },
        ],
      },
    }),
    "Collected 2 outputs · 512 B · /workfiles/report.md, /workfiles/chart.csv",
  );
});

test("summarizes sandbox collect recoverable failures for tool cards", () => {
  assert.equal(
    getSandboxToolResultSummary({
      toolName: "collect_sandbox_outputs",
      output: {
        ok: false,
        type: "sandbox_collect_error",
        status: "failed",
        code: "SANDBOX_COLLECT_CONFLICT",
        message: "/workfiles/report.md already exists",
        recoverable: true,
      },
    }),
    "Failed · SANDBOX_COLLECT_CONFLICT · /workfiles/report.md already exists",
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
          { target: { path: "/workfiles/report.md" } },
          { targetPath: "/workfiles/chart.csv" },
        ],
      },
    }),
    [
      { label: "Operation", value: "Collected sandbox outputs" },
      { label: "Outputs", value: "2 files" },
      { label: "Size", value: "512 B" },
      {
        label: "Output paths",
        value: "/workfiles/report.md, /workfiles/chart.csv",
      },
    ],
  );
});

test("extracts unique collected /workfiles paths for clickable tool-card links", () => {
  assert.deepEqual(
    getSandboxCollectedWorkfilePaths({
      toolName: "collect_sandbox_outputs",
      output: {
        ok: true,
        outputs: [
          { target: { path: "/workfiles/report.md" } },
          { targetPath: "/workfiles/report.md" },
          { targetPath: "/workspace/output/internal.txt" },
          { targetPath: "/workfiles/charts/summary.csv" },
        ],
      },
    }),
    ["/workfiles/report.md", "/workfiles/charts/summary.csv"],
  );
});

test("does not extract collected workfile links for non-collect tools", () => {
  assert.deepEqual(
    getSandboxCollectedWorkfilePaths({
      toolName: "execute",
      output: {
        ok: true,
        outputs: [{ targetPath: "/workfiles/report.md" }],
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
              outputs: [{ targetPath: "/workfiles/report.md" }],
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
        "SANDBOX_COLLECT_CONFLICT: /workfiles/report.md already exists. Set overwrite=true or choose a new path.",
    }),
    "A target /workfiles file already exists. Choose a different destination or approve the operation again with overwrite enabled.",
  );
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "prepare_sandbox_workspace",
      error: "SANDBOX_TOTAL_SIZE_EXCEEDED: prepared files exceed total limit.",
    }),
    "The selected files exceed the total sandbox transfer limit. Reduce the number or size of files and try again.",
  );
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "prepare_sandbox_workspace",
      error:
        "SANDBOX_PREPARE_PATH_DENIED: sourcePath must be under /workfiles/.",
    }),
    "Prepare requires sourcePath under SourceWeft DB-backed /workfiles and sandboxPath under a provider-allowed prepare target root.",
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
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "execute",
      error:
        "SANDBOX_EXECUTE_VFS_PATH_DENIED: execute commands must not include /workfiles.",
    }),
    "Execute commands referenced a SourceWeft VFS path that is not available in the sandbox. Create or edit Workfiles with file tools, prepare them into /workspace, then run the command against /workspace paths.",
  );
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "execute",
      error:
        "SANDBOX_SKILL_STAGING_UNAVAILABLE: skill bundles could not be staged into this sandbox, so /skills paths are not executable here.",
    }),
    "Skill files could not be staged into this sandbox, so /skills paths cannot be executed here. Read the skill file with file tools, save the needed content as a Workfile, prepare it into /workspace, then run that copy.",
  );
});

test("keeps normalized execute exit-code errors visible", () => {
  assert.equal(
    getSandboxToolSafeErrorMessage({
      toolName: "execute",
      error: "Command failed with exit code 2.",
    }),
    "Command failed with exit code 2.",
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
