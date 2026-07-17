import assert from "node:assert/strict";
import { test } from "vitest";
import { collectPendingVideoPresentationArtifactIds } from "./video-presentation-artifacts";

test("collects video presentation artifact ids from assistant tool metadata", () => {
  assert.deepEqual(
    collectPendingVideoPresentationArtifactIds([
      {
        metadata: {
          toolCalls: [
            {
              id: "tool-1",
              tool: "generate_video_presentation",
              input: {},
              output: {
                content: JSON.stringify({
                  type: "video_presentation_processing_result",
                  artifact_id: "artifact-1",
                  artifact_url:
                    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
                  file_name: "feynman.mp4",
                  status: "running",
                }),
              },
              status: "completed",
              latencyMs: 10,
              error: null,
            },
            {
              id: "tool-3",
              tool: "generate_video_presentation",
              input: {},
              output: {
                type: "generate_video_presentation_progress",
                artifact_id: "artifact-progress-1",
                status: "running",
                stage: "generating_scene_modules",
              },
              status: "running",
              latencyMs: null,
              error: null,
            },
            {
              id: "tool-2",
              tool: "publish_artifact",
              input: {},
              output: {
                artifact_id: "slides-1",
              },
              status: "completed",
              latencyMs: 10,
              error: null,
            },
          ],
        },
      },
    ]),
    ["artifact-1", "artifact-progress-1"],
  );
});
