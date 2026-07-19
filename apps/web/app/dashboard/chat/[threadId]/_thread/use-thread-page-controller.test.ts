import assert from "node:assert/strict";
import { test } from "vitest";
import { collectPendingArtifactIds } from "../../_components/chat-canvas/artifact-work-state";
import { hasActivelyRunningToolWork } from "../../_components/chat-canvas/tool-confirmation-state";

test("collects pending artifact ids from assistant tool metadata", () => {
  assert.deepEqual(
    collectPendingArtifactIds([
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

test("collects artifact ids from LangChain ToolMessage wrappers", () => {
  assert.deepEqual(
    collectPendingArtifactIds([
      {
        metadata: {
          toolCalls: [
            {
              id: "tool-1",
              tool: "generate_video_presentation",
              input: {},
              output: {
                type: "tool",
                status: "success",
                stage: "planning_storyboard",
                progress: 0,
                artifact_id: "artifact-wrapped-1",
                content: JSON.stringify({
                  type: "video_presentation_processing_result",
                  artifact_id: "artifact-wrapped-1",
                  status: "running",
                  stage: "planning_storyboard",
                }),
              },
              status: "completed",
              latencyMs: 597,
              error: null,
            },
          ],
        },
      },
    ]),
    ["artifact-wrapped-1"],
  );
});

test("collects artifact ids from persisted flattened LangChain ToolMessage shape", () => {
  assert.deepEqual(
    collectPendingArtifactIds([
      {
        metadata: {
          toolCalls: [
            {
              id: "call_07f1da82a09547478d10dae0",
              tool: "generate_video_presentation",
              input: {},
              output: {
                id: "d201011c-b192-4b5c-9bd3-2967de34aea1",
                name: "generate_video_presentation",
                type: "tool",
                status: "success",
                stage: "planning_storyboard",
                progress: 0,
                artifact_id: "80c725a2-5caf-4177-8752-d20939a16342",
                lc_kwargs: {
                  content: JSON.stringify({
                    type: "video_presentation_processing_result",
                    artifact_id: "80c725a2-5caf-4177-8752-d20939a16342",
                    status: "running",
                    stage: "planning_storyboard",
                  }),
                  status: "success",
                },
                content: JSON.stringify({
                  type: "video_presentation_processing_result",
                  artifact_id: "80c725a2-5caf-4177-8752-d20939a16342",
                  status: "running",
                  stage: "planning_storyboard",
                }),
                lc_serializable: true,
                lc_direct_tool_output: true,
              },
              status: "completed",
              latencyMs: 597,
              error: null,
            },
          ],
        },
      },
    ]),
    ["80c725a2-5caf-4177-8752-d20939a16342"],
  );
});

test("hasActivelyRunningToolWork uses version toolCalls without metadata", () => {
  assert.equal(
    hasActivelyRunningToolWork({
      messages: [
        {
          toolCalls: [
            {
              id: "tool-1",
              tool: "generate_video_presentation",
              input: {},
              output: {
                type: "video_presentation_processing_result",
                artifact_id: "artifact-1",
                status: "running",
                stage: "planning_storyboard",
              },
              status: "completed",
              latencyMs: 200,
              error: null,
            },
          ],
        },
      ],
    }),
    true,
  );

  assert.equal(
    hasActivelyRunningToolWork({
      artifactStatuses: new Map([
        [
          "artifact-1",
          {
            id: "artifact-1",
            status: "ready",
            payloadJson: {
              generation: { status: "ready", stage: "ready", progress: 100 },
            },
          } as never,
        ],
      ]),
      messages: [
        {
          toolCalls: [
            {
              id: "tool-1",
              tool: "generate_video_presentation",
              input: {},
              output: {
                type: "video_presentation_processing_result",
                artifact_id: "artifact-1",
                status: "running",
              },
              status: "completed",
              latencyMs: 200,
              error: null,
            },
          ],
        },
      ],
    }),
    false,
  );
});
