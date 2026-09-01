import assert from "node:assert/strict";
import { test } from "vitest";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import {
  commandSuccessFailureText,
  isCommandSuccessSatisfied,
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
