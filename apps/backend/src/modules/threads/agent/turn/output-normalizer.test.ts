import assert from "node:assert/strict";
import { test } from "vitest";
import {
  appendSandboxOperationTimeline,
  formatToolInputItems,
  getFilesystemToolClientMetadata,
  getFilesystemToolDescription,
  getFilesystemToolEndTitle,
  getFilesystemToolFailureMetadata,
  getFilesystemToolOutputError,
  getFilesystemToolStartTitle,
  getSkillInstructionDisplayMetadata,
  getArtifactProgressToolOutputError,
  isVideoPresentationArtifactReady,
  normalizeToolOutputForObservability,
  sanitizeThreadMessageMetadataForClient,
  sanitizeFilesystemToolInputForClient,
} from "./output-normalizer";

test("sandbox operation timeline augments client observability without changing model output", () => {
  const operations = [
    {
      operationType: "execute",
      status: "succeeded",
      durationMs: 42,
      createdAt: "2026-08-16T08:00:00.000Z",
      result: { exitCode: 0, outputChars: 5 },
    },
  ];

  assert.deepEqual(
    appendSandboxOperationTimeline("execute", "hello", operations),
    { content: "hello", operations },
  );
  assert.deepEqual(
    appendSandboxOperationTimeline(
      "collect_sandbox_outputs",
      { ok: true, outputs: [] },
      operations,
    ),
    { ok: true, outputs: [], operations },
  );
  assert.equal(
    appendSandboxOperationTimeline("read_file", "hello", operations),
    "hello",
  );
});

/**
 * The output shapes below are written out as literals rather than built with a
 * capability's result builder. What is under test is the host's reading of a
 * tool output — that `status: "running"` beats the presence of an artifact_url
 * — and building the fixture with the real builder made this test fail whenever
 * that capability changed a field it does not read.
 */
test("video presentation running output with artifact_url is not ready", () => {
  const runningOutput = {
    type: "video_presentation_processing_result",
    artifact_id: "artifact-1",
    artifact_url: "/artifact-preview?artifactId=artifact-1",
    file_name: "demo.video-presentation.json",
    narration_enabled: true,
    status: "running",
    title: "Demo",
  };

  assert.equal(isVideoPresentationArtifactReady(runningOutput), false);
  assert.equal(
    getFilesystemToolEndTitle(
      "generate_video_presentation",
      {},
      runningOutput,
    ),
    "Video presentation generating",
  );
});

test("video presentation ready output is marked ready", () => {
  const readyOutput = {
    artifact_url: "/artifact-preview?artifactId=artifact-1",
    status: "ready",
  };

  assert.equal(isVideoPresentationArtifactReady(readyOutput), true);
  assert.equal(
    getFilesystemToolEndTitle(
      "generate_video_presentation",
      {},
      readyOutput,
    ),
    "Video presentation ready",
  );
});

test("video presentation failed output exposes error text", () => {
  const failedOutput = {
    type: "video_presentation_artifact_result",
    artifact_url: "/artifact-preview?artifactId=artifact-1",
    status: "failed",
    error:
      "VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED: Storyboard provider call failed: The operation was aborted due to timeout",
  };

  assert.equal(
    getArtifactProgressToolOutputError(failedOutput),
    failedOutput.error,
  );
  assert.equal(
    getFilesystemToolEndTitle(
      "generate_video_presentation",
      {},
      failedOutput,
    ),
    "Video presentation failed",
  );
});

test("unwraps LangChain ToolMessage video presentation outputs for observability", () => {
  const structured = {
    type: "video_presentation_processing_result",
    artifact_id: "artifact-1",
    status: "running",
    stage: "planning_storyboard",
  };
  const output = normalizeToolOutputForObservability(
    "generate_video_presentation",
    {
      type: "tool",
      status: "success",
      stage: "planning_storyboard",
      artifact_id: "artifact-1",
      content: JSON.stringify(structured),
      lc_kwargs: {
        content: JSON.stringify(structured),
        status: "success",
      },
    },
  );

  assert.deepEqual(output, structured);
});

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

test("normalizes read_file output to display-safe bounded content", () => {
  const output = normalizeToolOutputForObservability("read_file", {
    type: "tool",
    lc_kwargs: {
      content: [{ text: `hello\u0000\u0001${"x".repeat(9000)}` }],
    },
  });

  // The normalizer returns `unknown` because it passes some outputs through
  // untouched, so narrow before asserting on the normalized shape.
  assert.ok(output && typeof output === "object" && "content" in output);
  const { content } = output as { content: unknown };
  assert.equal(typeof content, "string");
  assert.match(content as string, /^hello�x/u);
  assert.match(content as string, /\[Output truncated for display.\]$/u);
  assert.ok((content as string).length < 8_100);
});

test("filesystem tool metadata marks skills reads as internal instructions", () => {
  assert.equal(
    getFilesystemToolStartTitle("read_file", {
      file_path: "/skills/feynman/SKILL.md",
    }),
    "Loading Feynman skill instructions",
  );
  assert.equal(
    getFilesystemToolEndTitle("read_file", {
      file_path: "/skills/feynman/SKILL.md",
    }),
    "Load Feynman skill instructions",
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
    "Loading skill instructions",
  );
  assert.equal(
    getFilesystemToolEndTitle("read_file", {
      path: "/skills",
    }),
    "Load skill instructions",
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
    "Loading PPT Deck skill instructions",
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
    "Load PPT Deck skill instructions",
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
      "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.\nHint: Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.\n[Command failed with exit code 1]",
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
      failureCode: "SANDBOX_EXECUTE_VFS_PATH_DENIED",
      exitCode: 1,
      output: "bad path",
    }),
    "SANDBOX_EXECUTE_VFS_PATH_DENIED",
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
        "Hint: Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.",
        "Diagnostics: toolName=execute commandFingerprint=sha256:abc failureCode=SANDBOX_EXECUTE_COMMAND_DENIED repeatCount=2 runId=run-1",
        "[Command failed with exit code 1]",
      ].join("\n"),
    ),
    {
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      failureHint:
        "Use a non-empty command without NUL bytes or unsafe control characters. Multiline shell commands are allowed.",
      failureMessage:
        "SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters.",
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
      output: "tests failed\n[Command failed with exit code 2]",
    }),
    {
      commandFingerprint: "sha256:abc",
      failureCode: "SANDBOX_EXECUTE_COMMAND_DENIED",
      repeatCount: 2,
      runId: "run-1",
    },
  );
  assert.deepEqual(
    getFilesystemToolFailureMetadata("execute", {
      output: "tests failed\n[Command failed with exit code 2]",
      exitCode: 2,
      truncated: false,
    }),
    {},
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
      title: "Load Feynman skill instructions",
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
      title: "Load Feynman skill instructions",
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
      title: "Load Feynman skill instructions",
    },
  ]);
});
