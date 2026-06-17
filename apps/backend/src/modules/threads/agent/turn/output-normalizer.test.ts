import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatToolInputItems,
  getFilesystemToolClientMetadata,
  getFilesystemToolDescription,
  getFilesystemToolEndTitle,
  getFilesystemToolFailureMetadata,
  getFilesystemToolOutputError,
  getFilesystemToolStartTitle,
  getSkillInstructionDisplayMetadata,
  normalizeToolOutputForObservability,
  sanitizeThreadMessageMetadataForClient,
  sanitizeFilesystemToolInputForClient,
} from "./output-normalizer";

test("redacts skills read_file output for client observability", () => {
  const output = normalizeToolOutputForObservability(
    "read_file",
    {
      type: "tool",
      lc_kwargs: {
        content: [{ text: "name: feynman\nsecret workflow details" }],
      },
    },
    { file_path: "/skills/feynman/SKILL.md" },
  );

  assert.deepEqual(output, {
    type: "skill_instruction_read",
    redacted: true,
    skillFileName: "SKILL.md",
    skillPath: "/skills/feynman/SKILL.md",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(output, "content"),
    false,
  );
});

test("filesystem tool metadata marks skills reads as internal instructions", () => {
  assert.equal(
    getFilesystemToolStartTitle("read_file", {
      file_path: "/skills/feynman/SKILL.md",
    }),
    "Reading Feynman skill instructions",
  );
  assert.equal(
    getFilesystemToolEndTitle("read_file", {
      file_path: "/skills/feynman/SKILL.md",
    }),
    "Read Feynman skill instructions",
  );
  assert.deepEqual(
    getSkillInstructionDisplayMetadata({
      file_path: "/skills/feynman/SKILL.md",
    }),
    {
      skillSlug: "feynman",
      skillDisplayName: "Feynman",
      skillFileName: "SKILL.md",
      skillPath: "/skills/feynman/SKILL.md",
    },
  );
  assert.deepEqual(
    getFilesystemToolClientMetadata("read_file", {
      file_path: "/skills/feynman/SKILL.md",
    }),
    {
      filesystemScope: "skills",
      skillDisplayName: "Feynman",
      skillFileName: "SKILL.md",
      skillPath: "/skills/feynman/SKILL.md",
      skillSlug: "feynman",
      visibility: "internal_instruction",
    },
  );
  assert.deepEqual(
    formatToolInputItems(
      { file_path: "/skills/feynman/SKILL.md" },
      "read_file",
    ),
    [],
  );
  assert.deepEqual(
    sanitizeFilesystemToolInputForClient("read_file", {
      file_path: "/skills/feynman/SKILL.md",
    }),
    {
      filesystemScope: "skills",
      redacted: true,
      skillDisplayName: "Feynman",
      skillFileName: "SKILL.md",
      skillPath: "/skills/feynman/SKILL.md",
      skillSlug: "feynman",
      visibility: "internal_instruction",
    },
  );
});

test("filesystem skill read titles fall back when no skill name is available", () => {
  assert.equal(
    getFilesystemToolStartTitle("read_file", {
      path: "/skills",
    }),
    "Reading skill instructions",
  );
  assert.equal(
    getFilesystemToolEndTitle("read_file", {
      path: "/skills",
    }),
    "Read skill instructions",
  );
  assert.deepEqual(
    sanitizeFilesystemToolInputForClient("read_file", {
      path: "/skills",
    }),
    {
      filesystemScope: "skills",
      redacted: true,
      visibility: "internal_instruction",
    },
  );
});

test("filesystem skill read titles prefer selected skill display names", () => {
  const options = {
    skillDisplayNamesBySlug: new Map([["ppt-deck", "PPT Deck"]]),
  };

  assert.equal(
    getFilesystemToolStartTitle(
      "read_file",
      {
        file_path: "/skills/ppt-deck/SKILL.md",
      },
      options,
    ),
    "Reading PPT Deck skill instructions",
  );
  assert.equal(
    getFilesystemToolEndTitle(
      "read_file",
      {
        file_path: "/skills/ppt-deck/SKILL.md",
      },
      undefined,
      options,
    ),
    "Read PPT Deck skill instructions",
  );
  assert.deepEqual(
    sanitizeFilesystemToolInputForClient(
      "read_file",
      {
        file_path: "/skills/ppt-deck/SKILL.md",
      },
      options,
    ),
    {
      filesystemScope: "skills",
      redacted: true,
      skillDisplayName: "PPT Deck",
      skillFileName: "SKILL.md",
      skillPath: "/skills/ppt-deck/SKILL.md",
      skillSlug: "ppt-deck",
      visibility: "internal_instruction",
    },
  );
});

test("filesystem tool descriptions remain unchanged for work and source reads", () => {
  assert.equal(
    getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/workfiles/notes.md" },
    ),
    "Read 1 Workfile chunk.",
  );
  assert.equal(
    getFilesystemToolDescription(
      "read_file",
      { chunkCount: 1 },
      { path: "/kb/source.md", limit: 100 },
    ),
    "Read up to 100 source lines.",
  );
});

test("execute recoverable failures normalize as filesystem tool errors", () => {
  assert.equal(
    getFilesystemToolOutputError(
      "execute",
      "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.\nHint: Use a non-empty single-line command without control characters.\n[Command failed with exit code 1]",
    ),
    "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
  );
  assert.equal(
    getFilesystemToolOutputError(
      "execute",
      "tests failed\n[Command failed with exit code 2]",
    ),
    "Command failed with exit code 2.",
  );
  assert.equal(
    getFilesystemToolOutputError("execute", {
      output: "SANDBOX_EXECUTE_CWD_DENIED: cwd must be under /workspace.",
      exitCode: 1,
      truncated: false,
    }),
    "SANDBOX_EXECUTE_CWD_DENIED: cwd must be under /workspace.",
  );
  assert.equal(
    getFilesystemToolOutputError("execute", {
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      exitCode: 1,
      output: "bad command",
    }),
    "SANDBOX_EXECUTE_COMMAND_DENIED",
  );
  assert.equal(
    getFilesystemToolOutputError("execute", {
      output: "tests failed",
      exitCode: 2,
      truncated: false,
    }),
    "Command failed with exit code 2.",
  );
  assert.equal(
    getFilesystemToolOutputError("read_file", "[Command failed with exit code 1]"),
    null,
  );
});

test("execute failure metadata is extracted for diagnostics", () => {
  assert.deepEqual(
    getFilesystemToolFailureMetadata(
      "execute",
      [
        "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
        "Diagnostics: toolName=execute commandFingerprint=sha256:abc failureCode=SANDBOX_EXECUTE_COMMAND_DENIED repeatCount=2 runId=run-1",
        "[Command failed with exit code 1]",
      ].join("\n"),
    ),
    {
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      repeatCount: 2,
      runId: "run-1",
    },
  );
  assert.deepEqual(
    getFilesystemToolFailureMetadata("execute", {
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      repeatCount: 2,
      runId: "run-1",
    }),
    {
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      repeatCount: 2,
      runId: "run-1",
    },
  );
  assert.deepEqual(
    getFilesystemToolFailureMetadata("read_file", {
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      repeatCount: 2,
      runId: "run-1",
    }),
    {},
  );
});

test("client metadata sanitization redacts persisted skill read payloads", () => {
  const metadata = sanitizeThreadMessageMetadataForClient({
    toolCalls: [
      {
        id: "call-skill",
        input: { path: "/skills/feynman/SKILL.md" },
        output: { content: "name: feynman\ninternal steps" },
        status: "completed",
        tool: "read_file",
      },
      {
        id: "call-work",
        input: { path: "/workfiles/notes.md" },
        output: { content: "safe work notes" },
        status: "completed",
        tool: "read_file",
      },
    ],
    traceParts: [
      {
        id: "call-skill",
        input: { file_path: "/skills/feynman/SKILL.md" },
        kind: "tool",
        output: { content: "skill markdown" },
        status: "completed",
        title: "Read /skills/feynman/SKILL.md",
        tool: "read_file",
        toolCallId: "call-skill",
      },
    ],
    thinkingSteps: [
      {
        id: "step-skill",
        items: ["path: /skills/feynman/SKILL.md"],
        metadata: {
          filesystemScope: "skills",
          tool: "read_file",
          toolCallId: "call-skill",
        },
        status: "completed",
        title: "Read /skills/feynman/SKILL.md",
        description: "skill markdown",
      },
    ],
  });

  assert.deepEqual(metadata.toolCalls, [
    {
      id: "call-skill",
      input: {
        filesystemScope: "skills",
        redacted: true,
        skillDisplayName: "Feynman",
        skillFileName: "SKILL.md",
        skillPath: "/skills/feynman/SKILL.md",
        skillSlug: "feynman",
        visibility: "internal_instruction",
      },
      output: {
        type: "skill_instruction_read",
        redacted: true,
        skillFileName: "SKILL.md",
        skillPath: "/skills/feynman/SKILL.md",
      },
      status: "completed",
      title: "Read Feynman skill instructions",
      tool: "read_file",
    },
    {
      id: "call-work",
      input: { path: "/workfiles/notes.md" },
      output: { content: "safe work notes" },
      status: "completed",
      tool: "read_file",
    },
  ]);
  assert.deepEqual(metadata.traceParts, [
    {
      id: "call-skill",
      input: {
        filesystemScope: "skills",
        redacted: true,
        skillDisplayName: "Feynman",
        skillFileName: "SKILL.md",
        skillPath: "/skills/feynman/SKILL.md",
        skillSlug: "feynman",
        visibility: "internal_instruction",
      },
      kind: "tool",
      output: {
        type: "skill_instruction_read",
        redacted: true,
        skillFileName: "SKILL.md",
        skillPath: "/skills/feynman/SKILL.md",
      },
      status: "completed",
      title: "Read Feynman skill instructions",
      tool: "read_file",
      toolCallId: "call-skill",
    },
  ]);
  assert.deepEqual(metadata.thinkingSteps, [
    {
      id: "step-skill",
      items: [],
      metadata: {
        filesystemScope: "skills",
        redacted: true,
        skillDisplayName: "Feynman",
        skillFileName: "SKILL.md",
        skillPath: "/skills/feynman/SKILL.md",
        skillSlug: "feynman",
        tool: "read_file",
        toolCallId: "call-skill",
        visibility: "internal_instruction",
      },
      status: "completed",
      title: "Read Feynman skill instructions",
    },
  ]);
});
