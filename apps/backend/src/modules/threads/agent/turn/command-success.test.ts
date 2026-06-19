import assert from "node:assert/strict";
import { test } from "vitest";
import { commandSuccessFailureText } from "./command-success";

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
