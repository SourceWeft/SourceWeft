import assert from "node:assert/strict";
import { test } from "vitest";
import {
  collectPendingArtifactIds,
  preferArtifactSnapshot,
} from "./artifact-work-state";

test("preferArtifactSnapshot never downgrades terminal to running", () => {
  const ready = {
    id: "artifact-1",
    status: "ready",
    updatedAt: "2026-07-18T00:02:00.000Z",
    payloadJson: {
      generation: { status: "ready", stage: "ready", progress: 100 },
    },
  } as never;
  const running = {
    id: "artifact-1",
    status: "running",
    updatedAt: "2026-07-18T00:03:00.000Z",
    payloadJson: {
      generation: {
        status: "running",
        stage: "planning_storyboard",
        progress: 0,
      },
    },
  } as never;

  assert.equal(preferArtifactSnapshot(ready, running)?.status, "ready");
  assert.equal(
    (
      preferArtifactSnapshot(ready, running)?.payloadJson as {
        generation: { status: string };
      }
    ).generation.status,
    "ready",
  );
});

test("preferArtifactSnapshot keeps richer step display when SSE is budgeted", () => {
  const rich = {
    id: "artifact-1",
    status: "running",
    updatedAt: "2026-07-18T00:02:00.000Z",
    payloadJson: {
      generation: {
        status: "running",
        stage: "planning_storyboard",
        progress: 12,
        pipelineSteps: [
          {
            id: "planning_storyboard",
            label: "Planning storyboard",
            status: "completed",
            summary: "Planned 2 slides",
            display: "# Storyboard\n\n1. **Agenda** — full plan text",
          },
        ],
      },
    },
  } as never;
  const budgeted = {
    id: "artifact-1",
    status: "running",
    updatedAt: "2026-07-18T00:02:00.000Z",
    payloadJson: {
      generation: {
        status: "running",
        stage: "planning_storyboard",
        progress: 12,
        pipelineSteps: [
          {
            id: "planning_storyboard",
            label: "Planning storyboard",
            status: "completed",
            summary: "Planned 2 slides",
            display: "# Storyboard",
          },
        ],
      },
    },
  } as never;

  const merged = preferArtifactSnapshot(rich, budgeted);
  const step = (
    merged?.payloadJson as {
      generation: {
        pipelineSteps: Array<{ display?: string }>;
      };
    }
  ).generation.pipelineSteps[0];
  assert.match(step?.display ?? "", /full plan text/);
});

test("preferArtifactSnapshot accepts newer terminal over older running", () => {
  const running = {
    id: "artifact-1",
    status: "running",
    updatedAt: "2026-07-18T00:01:00.000Z",
    payloadJson: {
      generation: { status: "running", stage: "planning_storyboard" },
    },
  } as never;
  const ready = {
    id: "artifact-1",
    status: "ready",
    updatedAt: "2026-07-18T00:02:00.000Z",
    payloadJson: {
      generation: { status: "ready", stage: "ready", progress: 100 },
    },
  } as never;

  assert.equal(preferArtifactSnapshot(running, ready)?.status, "ready");
});

test("collectPendingArtifactIds skips known terminal snapshots", () => {
  const messages = [
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
          status: "completed" as const,
          latencyMs: 200,
          error: null,
        },
      ],
    },
  ];

  assert.deepEqual(collectPendingArtifactIds(messages), ["artifact-1"]);
  assert.deepEqual(
    collectPendingArtifactIds(
      messages,
      new Map([
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
    ),
    [],
  );
});
