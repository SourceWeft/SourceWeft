import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import {
  commandExecutionPolicyFor,
  commandSuccessFailureText,
  isCommandSuccessSatisfied,
  resolveFinalAssistantText,
  shouldSuppressLeakedCommandSpecText,
  shouldSuppressRawToolCallText,
} from "./command-success";

const committedPublisher = defineAgentTool({
  id: "testCommittedPublisher",
  name: "test_committed_publisher",
  domain: "artifact",
  capabilities: ["artifact"],
  activation: {
    default: "off",
    userControl: "none",
    skill: { declarable: false, activates: false },
  },
  terminalResult: {
    kind: "committed_artifact",
    artifactType: "test_artifact",
  },
});
registerAgentTools([committedPublisher]);

test("command failure uses presentation publisher recoverable error message", () => {
  assert.equal(
    commandSuccessFailureText(
      {
        kind: "artifact",
        artifactType: "slides",
        toolName: "publish_artifact",
      },
      [
        {
          id: "tool-1",
          input: {},
          output: {
            ok: false,
            type: "presentation_artifact_error",
            status: "failed",
            code: "PUBLISH_INPUT_INVALID",
            message: "source.kind is required; source.path is required",
            recoverable: true,
          },
          status: "completed",
          tool: "publish_artifact",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    ),
    "Command failed because publish_artifact reported: source.kind is required; source.path is required",
  );
});

test("generic artifact command failure uses the publisher error", () => {
  assert.equal(
    commandSuccessFailureText(
      {
        kind: "artifact",
        artifactType: "custom_report",
        toolName: "publish_report",
      },
      [
        {
          id: "tool-1",
          input: {},
          output: {
            artifact_id: "artifact-1",
            artifact_url: "/artifact-preview?artifactId=artifact-1",
            error: "Provider returned invalid JSON content.",
            job_id: "report-generate_artifact-1",
            status: "failed",
            type: "custom_artifact_result",
          },
          status: "completed",
          tool: "publish_report",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    ),
    "Command failed because publish_report reported: Provider returned invalid JSON content.",
  );
});

test("registered committed-artifact result satisfies capability-owned success", () => {
  const criteria = {
    kind: "artifact" as const,
    artifactType: "test_artifact",
    toolName: committedPublisher.name,
  };
  const call = {
    id: "committed-call",
    input: {},
    output: {
      status: "ready",
      type: "committed_artifact_result",
      artifactType: "test_artifact",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      artifactOutputBlockId: "artifact-output:run-1:artifact-1:version-1",
      workflowVersion: "test-workflow",
    },
    status: "completed" as const,
    tool: committedPublisher.name,
    latencyMs: 10,
    error: null,
    sequence: 1,
  };

  assert.equal(
    isCommandSuccessSatisfied({ criteria, toolCalls: [call] }),
    true,
  );
  assert.equal(
    isCommandSuccessSatisfied({
      criteria,
      toolCalls: [
        {
          ...call,
          output: { status: "ready", artifactId: "artifact-1" },
        },
      ],
    }),
    false,
  );
  assert.equal(
    isCommandSuccessSatisfied({
      criteria,
      toolCalls: [
        {
          ...call,
          output: { ...call.output, artifactType: "wrong_artifact" },
        },
      ],
    }),
    false,
  );
  assert.equal(
    isCommandSuccessSatisfied({
      criteria,
      toolCalls: [
        {
          ...call,
          output: { ...call.output, artifactOutputBlockId: "" },
        },
      ],
    }),
    false,
  );
});

describe("from runner.test.ts", () => {
  test("command execution policy is disabled for incomplete clarification workflows", () => {
    const prepared = {
      command: {
        kind: "tool",
        workflow: {
          execution: "agent",
        },
      },
      commandSuccessCriteria: { kind: "none" },
    } as unknown as Parameters<typeof commandExecutionPolicyFor>[0];

    assert.equal(commandExecutionPolicyFor(prepared), undefined);
  });

  test("command execution policy force-targets complete explicit tool commands", () => {
    const prepared = {
      command: {
        kind: "tool",
        workflow: {
          execution: "agent",
        },
      },
      commandSuccessCriteria: {
        kind: "tool_call",
        toolName: "search_notion_pages",
      },
    } as unknown as Parameters<typeof commandExecutionPolicyFor>[0];

    assert.deepEqual(commandExecutionPolicyFor(prepared), {
      initialToolPolicy: {
        kind: "force",
        toolName: "search_notion_pages",
      },
    });
  });

  test("command execution policy does not force publisher tools for skill artifact workflows", () => {
    const prepared = {
      command: {
        kind: "skill",
        workflow: {
          execution: "agent",
        },
      },
      commandSuccessCriteria: {
        kind: "artifact",
        artifactType: "slides",
        toolName: "publish_artifact",
      },
    } as unknown as Parameters<typeof commandExecutionPolicyFor>[0];

    assert.equal(commandExecutionPolicyFor(prepared), undefined);
  });

  test("command execution policy keeps automatic skill entry separate from terminal publisher", () => {
    const prepared = {
      command: {
        kind: "skill",
        workflow: {
          execution: "agent",
          initialToolPolicy: "auto",
          toolPolicy: {
            allow: ["write_file", "publish_video_presentation"],
            deny: ["task", "execute"],
          },
        },
      },
      commandSuccessCriteria: {
        kind: "artifact",
        artifactType: "video_presentation",
        toolName: "publish_video_presentation",
      },
    } as unknown as Parameters<typeof commandExecutionPolicyFor>[0];

    assert.deepEqual(commandExecutionPolicyFor(prepared), {
      initialToolPolicy: "auto",
      toolPolicy: {
        allow: ["write_file", "publish_video_presentation"],
        deny: ["task", "execute"],
      },
    });
  });

  test("selected skill tool policy applies without a slash command", () => {
    const prepared = {
      command: null,
      activeToolPolicy: {
        allow: ["write_todos", "publish_video_presentation"],
        deny: ["task"],
      },
      commandSuccessCriteria: { kind: "none" },
    } as unknown as Parameters<typeof commandExecutionPolicyFor>[0];

    assert.deepEqual(commandExecutionPolicyFor(prepared), {
      initialToolPolicy: "auto",
      toolPolicy: prepared.activeToolPolicy,
    });
  });

  test("final assistant text stays empty for tool-only successful turns", () => {
    assert.equal(
      resolveFinalAssistantText({
        assistantContent: "",
        assistantContentFromUpdates: null,
        hasCompletedToolOutput: true,
      }),
      "",
    );
    assert.equal(
      resolveFinalAssistantText({
        assistantContent: "",
        assistantContentFromUpdates: null,
        hasCompletedToolOutput: false,
      }),
      "Model returned an empty response.",
    );
  });

  test("final assistant text preserves natural artifact summaries", () => {
    assert.equal(
      resolveFinalAssistantText({
        assistantContent: "已生成 PPT，重点是概念、步骤和练习。",
        assistantContentFromUpdates: null,
        commandSuccessCriteria: {
          artifactType: "slides",
          kind: "artifact",
          toolName: "publish_artifact",
        },
        hasCompletedToolOutput: true,
      }),
      "已生成 PPT，重点是概念、步骤和练习。",
    );
  });

  test("final assistant text can stay silent for rejected approval resumes", () => {
    assert.equal(
      resolveFinalAssistantText({
        assistantContent: "",
        assistantContentFromUpdates: null,
        hasCompletedToolOutput: false,
        allowSilentEmptyResponse: true,
      }),
      "",
    );
  });

  test("suppresses leaked presentation publisher outputs without suppressing natural summaries", () => {
    const criteria = {
      artifactType: "slides" as const,
      kind: "artifact" as const,
      toolName: "publish_artifact",
    };

    assert.equal(
      shouldSuppressLeakedCommandSpecText({
        assistantContent: "",
        criteria,
        delta:
          '{"ok":true,"artifactId":"artifact-1","artifactUrl":"/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1"}',
        suppressing: false,
      }),
      true,
    );
    assert.equal(
      shouldSuppressLeakedCommandSpecText({
        assistantContent: "",
        criteria,
        delta: "我已经生成了这份费曼学习法的 PPT，结构是概念、步骤和练习。",
        suppressing: false,
      }),
      false,
    );
    assert.equal(
      shouldSuppressLeakedCommandSpecText({
        assistantContent: "",
        criteria,
        delta: "artifact_url: /artifact-preview?artifactId=artifact-1",
        suppressing: false,
      }),
      true,
    );
  });

  test("final assistant text prefers real assistant content over silent approval resume", () => {
    assert.equal(
      resolveFinalAssistantText({
        assistantContent: "The action was cancelled.",
        assistantContentFromUpdates: null,
        hasCompletedToolOutput: false,
        allowSilentEmptyResponse: true,
      }),
      "The action was cancelled.",
    );
    assert.equal(
      resolveFinalAssistantText({
        assistantContent: "",
        assistantContentFromUpdates: "The action was cancelled.",
        hasCompletedToolOutput: false,
        allowSilentEmptyResponse: true,
      }),
      "The action was cancelled.",
    );
  });

  test("command success requires generated image artifact metadata", () => {
    assert.equal(
      isCommandSuccessSatisfied({
        criteria: {
          artifactType: "image",
          kind: "artifact",
          toolName: "generate_image",
        },
        toolCalls: [
          {
            id: "tool-1",
            input: {},
            output: "Image artifact created.\nartifact_id: artifact-1",
            status: "completed",
            tool: "generate_image",
            latencyMs: 10,
            error: null,
            sequence: 1,
          },
        ],
      }),
      false,
    );
    assert.equal(
      isCommandSuccessSatisfied({
        criteria: {
          artifactType: "image",
          kind: "artifact",
          toolName: "generate_image",
        },
        toolCalls: [
          {
            id: "tool-1",
            input: {},
            output:
              "Image artifact created.\nartifact_id: artifact-1\nartifact_url: /artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
            status: "completed",
            tool: "generate_image",
            latencyMs: 10,
            error: null,
            sequence: 1,
          },
        ],
      }),
      true,
    );
  });

  test("command success accepts published PPTX artifact output", () => {
    assert.equal(
      isCommandSuccessSatisfied({
        criteria: {
          kind: "artifact",
          artifactType: "slides",
          toolName: "publish_artifact",
        },
        toolCalls: [
          {
            id: "tool-1",
            input: {},
            output: {
              artifact_url:
                "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
            },
            status: "completed",
            tool: "publish_artifact",
            latencyMs: 10,
            error: null,
            sequence: 1,
          },
        ],
      }),
      true,
    );
    assert.equal(
      isCommandSuccessSatisfied({
        criteria: {
          kind: "artifact",
          artifactType: "slides",
          toolName: "publish_artifact",
        },
        toolCalls: [
          {
            id: "tool-1",
            input: {},
            output: {},
            status: "completed",
            tool: "publish_artifact",
            latencyMs: 10,
            error: null,
            sequence: 1,
          },
        ],
      }),
      false,
    );
  });

  test("raw textual tool calls are suppressed while command success is pending", () => {
    assert.equal(
      shouldSuppressRawToolCallText({
        assistantContent: "",
        criteria: {
          artifactType: "slides",
          kind: "artifact",
          toolName: "publish_artifact",
        },
        delta: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="publish_artifact">',
        suppressing: false,
      }),
      true,
    );
    assert.equal(
      shouldSuppressRawToolCallText({
        assistantContent: "",
        criteria: {
          artifactType: "slides",
          kind: "artifact",
          toolName: "publish_artifact",
        },
        delta: "普通回答",
        suppressing: false,
      }),
      false,
    );
    assert.equal(
      shouldSuppressRawToolCallText({
        assistantContent: "前置说明",
        criteria: {
          artifactType: "slides",
          kind: "artifact",
          toolName: "publish_artifact",
        },
        delta: "<｜DSML｜tool_calls>",
        suppressing: false,
      }),
      false,
    );
  });

  test("command success accepts structured presentation artifact output", () => {
    assert.equal(
      isCommandSuccessSatisfied({
        criteria: {
          artifactType: "slides",
          kind: "artifact",
          toolName: "publish_artifact",
        },
        toolCalls: [
          {
            id: "tool-1",
            input: {},
            output: {
              artifact_id: "artifact-1",
              artifact_url:
                "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
              title: "费曼学习法",
            },
            status: "completed",
            tool: "publish_artifact",
            latencyMs: 10,
            error: null,
            sequence: 1,
          },
        ],
      }),
      true,
    );
  });
});
