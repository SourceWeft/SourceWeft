import assert from "node:assert/strict";
import test from "node:test";
import {
  createArtifactProgressProtocol,
  extractArtifactIdFromOutput,
  readArtifactGeneration,
  resolveArtifactElapsedMs,
  resolveArtifactGenerationStatus,
} from "../src/artifact-progress";
import type { ArtifactPipelineStep } from "../src/artifact-pipeline";

const INITIAL_STEPS: ArtifactPipelineStep[] = [
  { id: "plan", label: "Plan", status: "pending" },
  { id: "build", label: "Build", status: "pending" },
  { id: "publish", label: "Publish", status: "pending" },
];

const protocol = createArtifactProgressProtocol({
  title: "Fake deliverable",
  outputTypes: ["fake_processing_result", "fake_artifact_result"],
  initialSteps: () => INITIAL_STEPS.map((step) => ({ ...step })),
});

test("reads generation out of a LangChain content-wrapped tool output", () => {
  // Tool output arrives wrapped in a JSON `content` string as often as it does
  // as a plain record; reading only top-level keys silently loses the payload.
  const wrapped = {
    content: JSON.stringify({
      type: "fake_processing_result",
      artifact_id: "artifact-1",
      generation: { status: "running", progress: 40 },
    }),
  };

  assert.equal(extractArtifactIdFromOutput(wrapped), "artifact-1");
  assert.equal(readArtifactGeneration(wrapped)?.status, "running");
  assert.equal(protocol.matchesOutputType(wrapped), true);
});

test("a bare JSON string output is unwrapped too", () => {
  const raw = JSON.stringify({ artifact_id: "artifact-2", status: "running" });
  assert.equal(extractArtifactIdFromOutput(raw), "artifact-2");
});

test("snapshot generation wins over a stale fire-and-forget tool row", () => {
  // The tool call returns immediately and its row says "running" forever; once
  // the snapshot exists it is the only authority.
  const status = resolveArtifactGenerationStatus({
    toolCallOutput: { artifact_id: "artifact-1", status: "running" },
    toolCallStatus: "completed",
    artifactSnapshot: {
      status: "ready",
      payloadJson: { generation: { status: "ready", progress: 100 } },
    },
  });
  assert.equal(status, "ready");
});

test("a live call's streamed output outranks the frozen one-shot snapshot", () => {
  // The snapshot is fetched once when the artifact first appears and never
  // refreshed while the run streams; SSE progress events keep rewriting the
  // tool output. Rendering the snapshot first froze the card at fetch time
  // until a page refresh — the live output must win while the call is live.
  const view = protocol.resolveProgressView({
    toolCallStatus: "running",
    toolCallOutput: {
      type: "fake_processing_result",
      artifact_id: "artifact-1",
      generation: {
        status: "running",
        progress: 66,
        pipelineSteps: [
          { id: "plan", label: "Plan", status: "completed" },
          { id: "build", label: "Build", status: "completed" },
          { id: "publish", label: "Publish", status: "running" },
        ],
      },
    },
    artifactSnapshot: {
      status: "running",
      payloadJson: {
        generation: {
          status: "pending",
          progress: 0,
          pipelineSteps: [
            { id: "plan", label: "Plan", status: "running" },
            { id: "build", label: "Build", status: "pending" },
            { id: "publish", label: "Publish", status: "pending" },
          ],
        },
      },
    },
  });

  assert.equal(view.status, "running");
  assert.equal(view.completedStepCount, 2);
  assert.equal(view.activeStepId, "publish");
});

test("before the first progress event the snapshot fills in", () => {
  // The tool's first outputs carry no generation record; the one-shot snapshot
  // (whose initial payload always has one) covers that gap.
  const view = protocol.resolveProgressView({
    toolCallStatus: "running",
    toolCallOutput: {
      type: "fake_processing_result",
      artifact_id: "artifact-1",
      status: "running",
    },
    artifactSnapshot: {
      status: "running",
      payloadJson: {
        generation: {
          status: "running",
          progress: 10,
          pipelineSteps: [
            { id: "plan", label: "Plan", status: "running" },
            { id: "build", label: "Build", status: "pending" },
            { id: "publish", label: "Publish", status: "pending" },
          ],
        },
      },
    },
  });

  assert.equal(view.completedStepCount, 0);
  assert.equal(view.activeStepId, "plan");
});

test("a completed call's persisted output never overrides the snapshot", () => {
  // Once the call completes its persisted output is forever stale; the
  // snapshot is the sole authority, even when the output carries a generation
  // record of its own.
  const view = protocol.resolveProgressView({
    toolCallStatus: "completed",
    toolCallOutput: {
      type: "fake_processing_result",
      artifact_id: "artifact-1",
      generation: {
        status: "running",
        progress: 50,
        pipelineSteps: [
          { id: "plan", label: "Plan", status: "completed" },
          { id: "build", label: "Build", status: "running" },
          { id: "publish", label: "Publish", status: "pending" },
        ],
      },
    },
    artifactSnapshot: {
      status: "ready",
      payloadJson: {
        generation: {
          status: "ready",
          progress: 100,
          pipelineSteps: [
            { id: "plan", label: "Plan", status: "completed" },
            { id: "build", label: "Build", status: "completed" },
            { id: "publish", label: "Publish", status: "completed" },
          ],
        },
      },
    },
  });

  assert.equal(view.status, "ready");
  assert.equal(view.completedStepCount, 3);
});

test("progress view reports step counts and the active step", () => {
  const view = protocol.resolveProgressView({
    artifactSnapshot: {
      status: "running",
      payloadJson: {
        generation: {
          status: "running",
          progress: 33,
          pipelineSteps: [
            { id: "plan", label: "Plan", status: "completed" },
            { id: "build", label: "Build", status: "running" },
            { id: "publish", label: "Publish", status: "pending" },
          ],
        },
      },
    },
  });

  assert.equal(view.status, "running");
  assert.equal(view.completedStepCount, 1);
  assert.equal(view.totalStepCount, 3);
  assert.equal(view.activeStepId, "build");
});

test("falls back to the capability's initial steps before any payload", () => {
  const view = protocol.resolveProgressView({
    toolCallOutput: { artifact_id: "artifact-1", status: "running" },
  });

  assert.equal(view.totalStepCount, 3);
  // The first pending step is shown active so the UI never looks stalled.
  assert.equal(view.activeStepId, "plan");
  assert.equal(view.completedStepCount, 0);
});

test("a ready artifact reports every step complete", () => {
  const view = protocol.resolveProgressView({
    artifactSnapshot: {
      status: "ready",
      payloadJson: {
        generation: {
          status: "ready",
          progress: 100,
          pipelineSteps: [
            { id: "plan", label: "Plan", status: "completed" },
            { id: "build", label: "Build", status: "running" },
          ],
        },
      },
    },
  });

  assert.equal(view.status, "ready");
  assert.equal(view.completedStepCount, 2);
  assert.equal(view.activeStepId, null);
});

test("failure surfaces the error message", () => {
  const view = protocol.resolveProgressView({
    artifactSnapshot: {
      status: "failed",
      payloadJson: {
        generation: {
          status: "failed",
          progress: 100,
          errorMessage: "render exploded",
        },
      },
    },
  });

  assert.equal(view.status, "failed");
  assert.equal(view.errorMessage, "render exploded");
});

test("elapsed time spans the pipeline, not the fire-and-forget call", () => {
  const elapsed = resolveArtifactElapsedMs({
    nowMs: Date.parse("2026-07-20T00:10:00.000Z"),
    artifactSnapshot: {
      status: "running",
      payloadJson: {
        generation: {
          status: "running",
          progress: 20,
          pipelineSteps: [
            {
              id: "plan",
              label: "Plan",
              status: "completed",
              startedAt: "2026-07-20T00:00:00.000Z",
              completedAt: "2026-07-20T00:02:00.000Z",
            },
          ],
        },
      },
    },
  });

  assert.equal(elapsed, 10 * 60_000);
});

test("terminal detection covers archived rows with no generation block", () => {
  assert.equal(protocol.isTerminal({ status: "archived" }), true);
  assert.equal(protocol.isTerminal({ status: "running" }), false);
  assert.equal(protocol.isTerminal(null), false);
});

test("progress tracking requires an artifact id", () => {
  assert.equal(
    protocol.isProgressTracking({ type: "fake_processing_result" }, null),
    false,
  );
  assert.equal(
    protocol.isProgressTracking(
      { type: "fake_processing_result", artifact_id: "artifact-1" },
      null,
    ),
    true,
  );
});
