import assert from "node:assert/strict";
import { test } from "vitest";
import {
  commandSuccessFailureText,
  isCommandSuccessSatisfied,
} from "./command-success";

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

test("video presentation command succeeds only after artifact is ready", () => {
  assert.equal(
    isCommandSuccessSatisfied({
      criteria: {
        kind: "artifact",
        artifactType: "video_presentation",
        toolName: "generate_video_presentation",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: {
            artifact_id: "artifact-1",
            artifact_url: "/artifact-preview?artifactId=artifact-1",
            job_id: "video-presentation-render_artifact-1",
            status: "ready",
            type: "video_presentation_artifact_result",
          },
          status: "completed",
          tool: "generate_video_presentation",
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
        artifactType: "video_presentation",
        toolName: "generate_video_presentation",
      },
      toolCalls: [
        {
          id: "tool-1",
          input: {},
          output: {
            artifact_id: "artifact-1",
            artifact_url: "/artifact-preview?artifactId=artifact-1",
            job_id: "video-presentation-render_artifact-1",
            status: "running",
            type: "video_presentation_artifact_result",
          },
          status: "completed",
          tool: "generate_video_presentation",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    }),
    false,
  );
});

test("video presentation command failure uses the artifact error", () => {
  assert.equal(
    commandSuccessFailureText(
      {
        kind: "artifact",
        artifactType: "video_presentation",
        toolName: "generate_video_presentation",
      },
      [
        {
          id: "tool-1",
          input: {},
          output: {
            artifact_id: "artifact-1",
            artifact_url: "/artifact-preview?artifactId=artifact-1",
            error: "Theme provider returned invalid JSON content.",
            job_id: "video-presentation-render_artifact-1",
            status: "failed",
            type: "video_presentation_artifact_result",
          },
          status: "completed",
          tool: "generate_video_presentation",
          latencyMs: 10,
          error: null,
          sequence: 1,
        },
      ],
    ),
    "Command failed because generate_video_presentation reported: Theme provider returned invalid JSON content.",
  );
});
