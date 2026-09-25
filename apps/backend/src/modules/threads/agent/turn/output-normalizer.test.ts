import assert from "node:assert/strict";
import { beforeAll, describe, test } from "vitest";
import { connectorAdaptersReady } from "../../../connectors";
import {
  appendSandboxOperationTimeline,
  extractGeneratedImageArtifacts,
  formatToolInputItems,
  getConnectorToolErrorTextContentError,
  getConnectorToolOutputContentError,
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
  assert.equal(Object.prototype.hasOwnProperty.call(output, "content"), false);
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
      { path: "/files/notes.md" },
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
    getFilesystemToolOutputError(
      "read_file",
      "[Command failed with exit code 1]",
    ),
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
        input: { path: "/files/notes.md" },
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
      input: { path: "/files/notes.md" },
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

test("client metadata excludes reasoning persistence state without hiding reasoning", () => {
  const input = {
    reasoning: "before\nafter",
    reasoningWrite: {
      runId: "run",
      parentRunId: "prior",
      base: "before",
      revision: 2,
      terminal: false,
    },
  };
  const result = sanitizeThreadMessageMetadataForClient(input);
  assert.equal(result.reasoning, input.reasoning);
  assert.equal("reasoningWrite" in result, false);
  assert.equal(input.reasoningWrite.base, "before");
});

test("physical PC paths are files, distinct from Sources and DB Files", () => {
  const input = { file_path: "/Users/example/Local task/report.txt" };
  assert.equal(getFilesystemToolStartTitle("read_file", input), "Reading file");
  assert.equal(getFilesystemToolEndTitle("read_file", input), "Read file");
  assert.equal(
    getFilesystemToolClientMetadata("read_file", input).filesystemScope,
    "files",
  );
  assert.equal(
    getFilesystemToolEndTitle("read_file", { file_path: "/kb/report.txt" }),
    "Read source content",
  );
  assert.equal(
    getFilesystemToolEndTitle("read_file", {
      file_path: "/files/report.txt",
    }),
    "Read Workfile",
  );
});

describe("from runner.test.ts", () => {
  // Connector tools register through an async import-time side effect. The
  // observability normalizer keys off that registry, so without awaiting it the
  // connector cases below race the registration and see an unregistered tool.
  beforeAll(async () => {
    await connectorAdaptersReady();
  });

  test("normalizes read_file ToolMessage output content for observability", () => {
    const output = normalizeToolOutputForObservability("read_file", {
      type: "tool",
      lc_kwargs: {
        content: [{ text: "Path: /kb/invoice.md\nInvoice total is 50." }],
      },
      self: "[Circular]",
    });

    assert.deepEqual(output, {
      content: "Path: /kb/invoice.md\nInvoice total is 50.",
    });
  });

  test("preserves non-read_file tool outputs", () => {
    const output = { content: "search result", self: "[Circular]" };

    assert.equal(
      normalizeToolOutputForObservability("search_sources", output),
      output,
    );
  });

  test("normalizes web tool outputs to display-safe metadata", () => {
    const output = normalizeToolOutputForObservability(
      "web_search",
      "Use these web search results internally.\n\n<web_result id='c1' rank='1' url='https://example.com/a' title='A'>Snippet</web_result>",
    );

    assert.deepEqual(output, {
      resultCount: 1,
      urlCount: 1,
      urls: ["https://example.com/a"],
      pages: [
        {
          url: "https://example.com/a",
          title: "A",
          rank: 1,
          citation: "c1",
          hasContent: false,
        },
      ],
      truncated: false,
    });
    assert.equal(
      JSON.stringify(output).includes(
        "Use these web search results internally",
      ),
      false,
    );
  });

  test("normalizes web_search failure outputs to display-safe metadata", () => {
    const output = normalizeToolOutputForObservability(
      "web_search",
      "web_search failed.\n\n<web_tool_error tool='web_search' provider='anycrawl' query='Shanghai weather' error='API Error 500: Internal server error'></web_tool_error>",
    );

    assert.deepEqual(output, {
      errorCount: 1,
      error: "API Error 500: Internal server error",
      query: "Shanghai weather",
      urlCount: 0,
      urls: [],
      truncated: false,
    });
  });

  test("connector tool error outputs are preserved for tool error handling", () => {
    const output = normalizeToolOutputForObservability("create_notion_page", {
      type: "connector_tool_error",
      code: "NOTION_TARGET_NOT_FOUND",
      message:
        "The provided sourceId does not resolve to an indexed Notion page.",
      statusCode: 400,
    });

    assert.deepEqual(output, {
      type: "connector_tool_error",
      code: "NOTION_TARGET_NOT_FOUND",
      message:
        "The provided sourceId does not resolve to an indexed Notion page.",
      statusCode: 400,
    });
  });

  test("connector success outputs hide raw provider payloads", () => {
    const output = normalizeToolOutputForObservability("create_notion_page", {
      url: "https://www.notion.so/page",
      title: "服务器配置查询总结",
      pageId: "page-1",
      postActionSyncRunId: "sync-1",
      content: "private conversation summary",
    });

    assert.deepEqual(output, {
      type: "connector_tool_result",
      connector: "notion",
      toolName: "create_notion_page",
      title: "服务器配置查询总结",
      url: "https://www.notion.so/page",
      pageId: "page-1",
    });
  });

  test("connector search outputs preserve public result details", () => {
    const output = normalizeToolOutputForObservability("search_notion_pages", {
      actionType: "notion.page.find",
      query: "服务器",
      resultCount: 2,
      pages: [
        {
          pageId: "page-1",
          title: "服务器配置",
          url: "https://www.notion.so/page-1",
          lastEditedTime: "2026-05-23T01:00:00.000Z",
          content: "private page body",
        },
        {
          pageId: "page-2",
          title: "服务器部署",
          url: "https://www.notion.so/page-2",
        },
      ],
    });

    assert.deepEqual(output, {
      type: "connector_tool_result",
      connector: "notion",
      toolName: "search_notion_pages",
      actionType: "notion.page.find",
      query: "服务器",
      resultCount: 2,
      pages: [
        {
          pageId: "page-1",
          title: "服务器配置",
          url: "https://www.notion.so/page-1",
          lastEditedTime: "2026-05-23T01:00:00.000Z",
        },
        {
          pageId: "page-2",
          title: "服务器部署",
          url: "https://www.notion.so/page-2",
        },
      ],
    });
  });

  test("connector confirmation outputs hide editable request payloads", () => {
    const output = normalizeToolOutputForObservability("create_notion_page", {
      type: "tool",
      lc_kwargs: {
        content: JSON.stringify({
          type: "tool_confirmation_request",
          schemaVersion: 1,
          id: "action-1",
          domain: "connector",
          subject: {
            label: "Lei Qin",
            provider: "notion",
            connectorId: "connector-1",
          },
          action: {
            type: "notion.page.create",
            toolName: "create_notion_page",
            label: "Create",
            riskLevel: "medium",
            status: "proposed",
            requiresApproval: true,
          },
          preview: {
            title: "Create Notion page: 服务器配置查询总结",
            requestJson: {
              title: "服务器配置查询总结",
              content: "private conversation summary",
            },
          },
          editableArgs: {
            value: {
              title: "服务器配置查询总结",
              content: "private conversation summary",
            },
          },
          decisionOptions: [
            { decision: "reject", label: "Reject" },
            { decision: "approve", label: "Approve" },
          ],
          execution: {
            providerStatus: "not_executed",
            executor: {
              kind: "connector_action_run",
              connectorId: "connector-1",
              actionRunId: "action-1",
            },
          },
          status: "proposed",
          userMessage: "Waiting for confirmation.",
        }),
      },
    });

    assert.equal(
      (output as Record<string, unknown>).type,
      "tool_confirmation_request",
    );
    assert.equal(
      "requestJson" in
        ((output as Record<string, unknown>).preview as Record<
          string,
          unknown
        >),
      false,
    );
    assert.equal("editableArgs" in (output as Record<string, unknown>), false);
  });

  test("connector approval mismatches are surfaced as content errors", () => {
    const error = getConnectorToolOutputContentError({
      type: "connector_tool_error",
      code: "CONNECTOR_ACTION_NOT_APPROVED",
      message:
        "Approved action was not found for this resumed tool call. Please retry the confirmation.",
      statusCode: 409,
    });

    assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
    assert.equal(error?.statusCode, 409);
  });

  test("connector approval mismatches are detected inside ToolMessage content", () => {
    const error = getConnectorToolOutputContentError({
      type: "tool",
      lc_kwargs: {
        content: JSON.stringify({
          type: "connector_tool_error",
          code: "CONNECTOR_ACTION_NOT_APPROVED",
          message:
            "Approved action was not found for this resumed tool call. Please retry the confirmation.",
          statusCode: 409,
        }),
      },
    });

    assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
  });

  test("connector approval mismatches are detected inside tool error text", () => {
    const error = getConnectorToolErrorTextContentError(
      "Error: Connector action must be approved before execution\n Please fix your mistakes.",
    );

    assert.equal(error?.code, "CONNECTOR_ACTION_APPROVAL_MISMATCH");
  });

  test("normalizes all-failed web_fetch outputs to display-safe metadata", () => {
    const output = normalizeToolOutputForObservability(
      "web_fetch",
      "<web_page rank='1' url='https://example.com' error='API Error 500: Internal server error'></web_page>",
    );

    assert.deepEqual(output, {
      pageCount: 1,
      errorCount: 1,
      urlCount: 1,
      urls: ["https://example.com"],
      pages: [
        {
          url: "https://example.com",
          rank: 1,
          error: "API Error 500: Internal server error",
          hasContent: true,
        },
      ],
      truncated: false,
    });
  });

  test("presentation artifact trace labels needs_content without claiming artifact creation", () => {
    const output = {
      content: JSON.stringify({
        type: "presentation_artifact_input_required",
        status: "needs_content",
        title: "费曼学习法",
      }),
    };

    assert.equal(
      getFilesystemToolEndTitle("publish_artifact", {}, output),
      "Deck content needed",
    );
    assert.equal(
      getFilesystemToolDescription(
        "publish_artifact",
        {
          resultType: "presentation_artifact_input_required",
          status: "needs_content",
        },
        {},
      ),
      "The deck tool needs explicit slide content before it can create an artifact.",
    );
  });

  test("filesystem tool titles classify glob scope from mounted pattern", () => {
    assert.equal(
      getFilesystemToolStartTitle("glob", {
        path: "/",
        pattern: "/files/**/*.md",
      }),
      "Finding matching Files",
    );
    assert.equal(
      getFilesystemToolEndTitle("glob", {
        path: "/",
        pattern: "/skills/**/*.md",
      }),
      "Found matching skill files",
    );
    assert.equal(
      getFilesystemToolDescription(
        "read_file",
        { chunkCount: 1 },
        { path: "/files/notes.md" },
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

  test("extracts generated image artifacts from completed tool calls", () => {
    const artifacts = extractGeneratedImageArtifacts([
      {
        id: "tool-1",
        tool: "generate_image",
        input: {},
        output: {
          content:
            "Image artifact created.\nartifact_id: artifact-1\ntitle: Concept [draft]\nartifact_url: /artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
        },
        sequence: 1,
        status: "completed",
        latencyMs: 100,
        error: null,
      },
    ]);

    assert.deepEqual(artifacts, [
      {
        artifactId: "artifact-1",
        artifactUrl:
          "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
        title: "Concept [draft]",
        toolCallId: "tool-1",
      },
    ]);
  });
});
