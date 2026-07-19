import assert from "node:assert/strict";
import { test } from "vitest";
import { GENERATE_VIDEO_PRESENTATION_TOOL_NAME } from "@sourceweft/contracts/agent-tools";
import { buildInitialVideoPresentationPipelineSteps } from "@sourceweft/contracts/video-presentation";
import {
  isDeliverableGenerationActive,
  isDeliverableToolName,
  resolveDeliverableElapsedMs,
  resolveDeliverableProgress,
  resolveDeliverableStatus,
  shouldSuppressDeliverableOutputSummary,
} from "./artifact-progress";

// Video presentation is the capability that currently contributes a progress
// protocol; these assertions cover the generic reader, not video specifically.
const toolName = GENERATE_VIDEO_PRESENTATION_TOOL_NAME;

test("only tools contributing a progress protocol are deliverables", () => {
  assert.equal(isDeliverableToolName(toolName), true);
  assert.equal(isDeliverableToolName("not_a_registered_tool"), false);
});

test("tools without a protocol resolve to null rather than a fabricated view", () => {
  const input = {
    toolName: "not_a_registered_tool",
    toolCallOutput: { status: "running" },
  };
  assert.equal(resolveDeliverableStatus(input), null);
  assert.equal(resolveDeliverableProgress(input), null);
  assert.equal(resolveDeliverableElapsedMs(input), null);
  assert.equal(isDeliverableGenerationActive(input), false);
  assert.equal(shouldSuppressDeliverableOutputSummary(input), false);
});

test("structured deliverable output suppresses the raw text summary", () => {
  assert.equal(
    shouldSuppressDeliverableOutputSummary({
      toolName,
      toolCallOutput: { type: "video_presentation_processing_result" },
    }),
    true,
  );
  assert.equal(
    shouldSuppressDeliverableOutputSummary({
      toolName,
      toolCallOutput: { type: "some_other_result" },
    }),
    false,
  );
});

test("resolveDeliverableProgress prefers artifact pipelineSteps", () => {
  const steps = buildInitialVideoPresentationPipelineSteps().map((step) =>
    step.id === "planning_storyboard"
      ? { ...step, status: "completed" as const, progress: 100 }
      : step.id === "generating_audio_tracks"
        ? { ...step, status: "running" as const, progress: 40 }
        : step,
  );

  const progress = resolveDeliverableProgress({
    toolName,
    toolCallOutput: {
      type: "video_presentation_processing_result",
      status: "processing",
      stage: "planning_storyboard",
      progress: 0,
    },
    artifactSnapshot: {
      id: "artifact-1",
      status: "running",
      payloadJson: {
        generation: {
          status: "running",
          stage: "generating_audio_tracks",
          progress: 42,
          pipelineSteps: steps,
        },
      },
    } as never,
  });

  assert.ok(progress);
  assert.equal(progress.activeStepId, "generating_audio_tracks");
  assert.equal(progress.status, "running");
  assert.equal(progress.steps.length, steps.length);
  assert.equal(progress.totalStepCount, steps.length);
  assert.equal(progress.completedStepCount, 1);
});

test("running with no payload yet shows the first step as active", () => {
  const progress = resolveDeliverableProgress({
    toolName,
    toolCallOutput: {
      type: "video_presentation_processing_result",
      status: "running",
      stage: "planning_storyboard",
    },
  });

  assert.ok(progress);
  assert.equal(progress.status, "running");
  assert.equal(progress.activeStepId, "planning_storyboard");
  assert.equal(progress.completedStepCount, 0);
  assert.equal(
    progress.totalStepCount,
    buildInitialVideoPresentationPipelineSteps().length,
  );
});

test("completed tool keeps generating until artifact snapshot loads", () => {
  const toolCallOutput = {
    type: "video_presentation_processing_result",
    artifact_id: "87c64d71-149a-400b-8604-d663b048faa6",
    status: "running",
    stage: "planning_storyboard",
    progress: 0,
  };

  // No snapshot yet: stay generating (do not flash ready after 200ms tool return).
  assert.equal(
    resolveDeliverableStatus({
      toolName,
      toolCallOutput,
      toolCallStatus: "completed",
    }),
    "running",
  );
  assert.equal(
    isDeliverableGenerationActive({
      toolName,
      toolCallOutput,
      toolCallStatus: "completed",
    }),
    true,
  );

  // Snapshot ready: stop generating even though tool output still says running.
  const artifactSnapshot = {
    id: "87c64d71-149a-400b-8604-d663b048faa6",
    status: "ready",
    payloadJson: {
      generation: { status: "ready", stage: "ready", progress: 100 },
    },
  } as never;

  assert.equal(
    resolveDeliverableStatus({
      toolName,
      toolCallOutput,
      toolCallStatus: "completed",
      artifactSnapshot,
    }),
    "ready",
  );
  assert.equal(
    isDeliverableGenerationActive({
      toolName,
      toolCallOutput,
      toolCallStatus: "completed",
      artifactSnapshot,
    }),
    false,
  );
});

test("snapshot status wins over a live tool output still claiming running", () => {
  const toolCallOutput = {
    type: "video_presentation_processing_result",
    artifact_id: "artifact-1",
    status: "running",
    stage: "planning_storyboard",
    progress: 0,
  };

  assert.equal(resolveDeliverableStatus({ toolName, toolCallOutput }), "running");
  assert.equal(
    isDeliverableGenerationActive({
      toolName,
      toolCallOutput,
      toolCallStatus: "running",
    }),
    true,
  );
  assert.equal(
    resolveDeliverableStatus({
      toolName,
      toolCallOutput,
      artifactSnapshot: { id: "artifact-1", status: "failed" } as never,
    }),
    "failed",
  );
  assert.equal(
    isDeliverableGenerationActive({
      toolName,
      toolCallOutput,
      artifactSnapshot: { id: "artifact-1", status: "failed" } as never,
    }),
    false,
  );
});

test("failed artifact surfaces its error message", () => {
  const progress = resolveDeliverableProgress({
    toolName,
    toolCallOutput: {
      type: "video_presentation_processing_result",
      status: "running",
      stage: "planning_storyboard",
    },
    artifactSnapshot: {
      id: "artifact-1",
      status: "failed",
      errorMessage: "Theme provider call failed",
      payloadJson: {
        generation: {
          status: "failed",
          stage: "failed",
          checkpointStage: "assigning_slide_themes",
          errorMessage: "Theme provider call failed",
        },
      },
    } as never,
  });

  assert.ok(progress);
  assert.equal(progress.status, "failed");
  assert.equal(progress.errorMessage, "Theme provider call failed");
});

test("generation.status running wins over artifact row status ready", () => {
  const artifactSnapshot = {
    id: "artifact-1",
    status: "ready",
    payloadJson: {
      generation: {
        status: "running",
        stage: "generating_scene_modules",
        progress: 68,
      },
    },
  } as never;

  assert.equal(resolveDeliverableStatus({ toolName, artifactSnapshot }), "running");
  assert.equal(
    isDeliverableGenerationActive({ toolName, artifactSnapshot }),
    true,
  );
  assert.equal(
    resolveDeliverableProgress({ toolName, artifactSnapshot })?.status,
    "running",
  );
});

test("stale processing_result defers to a ready artifact snapshot", () => {
  const toolCallOutput = {
    type: "video_presentation_processing_result",
    artifact_id: "87c64d71-149a-400b-8604-d663b048faa6",
    status: "running",
    stage: "planning_storyboard",
    progress: 0,
  };
  const steps = buildInitialVideoPresentationPipelineSteps().map((step) => ({
    ...step,
    status: "completed" as const,
    progress: 100,
  }));
  const artifactSnapshot = {
    id: "87c64d71-149a-400b-8604-d663b048faa6",
    status: "ready",
    payloadJson: {
      generation: {
        status: "ready",
        stage: "ready",
        progress: 100,
        pipelineSteps: steps,
      },
    },
  } as never;

  assert.equal(
    resolveDeliverableStatus({ toolName, toolCallOutput, artifactSnapshot }),
    "ready",
  );

  const progress = resolveDeliverableProgress({
    toolName,
    toolCallOutput,
    artifactSnapshot,
    toolCallStatus: "completed",
  });
  assert.ok(progress);
  assert.equal(progress.status, "ready");
  assert.equal(progress.activeStepId, null);
  assert.equal(progress.completedStepCount, progress.totalStepCount);
});

test("ready artifact without generation block ignores stale planning stage", () => {
  const progress = resolveDeliverableProgress({
    toolName,
    toolCallOutput: {
      type: "video_presentation_processing_result",
      artifact_id: "f55327e0-c10d-489f-b03a-5925d5490349",
      status: "running",
      stage: "planning_storyboard",
      progress: 0,
    },
    toolCallStatus: "completed",
    artifactSnapshot: {
      id: "f55327e0-c10d-489f-b03a-5925d5490349",
      status: "ready",
      payloadJson: {},
    } as never,
  });

  assert.ok(progress);
  assert.equal(progress.status, "ready");
  assert.equal(progress.activeStepId, null);
  assert.ok(progress.steps.every((step) => step.status === "completed"));
  assert.equal(progress.completedStepCount, progress.totalStepCount);
});

test("failed artifact with stale processing_result shows failed", () => {
  const toolCallOutput = {
    type: "video_presentation_processing_result",
    artifact_id: "80c725a2-5caf-4177-8752-d20939a16342",
    status: "running",
    stage: "planning_storyboard",
    progress: 0,
  };
  const artifactSnapshot = {
    id: "80c725a2-5caf-4177-8752-d20939a16342",
    status: "failed",
    errorMessage:
      "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED: Theme provider call failed",
    payloadJson: {
      generation: {
        status: "failed",
        stage: "failed",
        checkpointStage: "assigning_slide_themes",
        errorMessage:
          "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED: Theme provider call failed",
      },
    },
  } as never;

  assert.equal(
    resolveDeliverableStatus({ toolName, toolCallOutput, artifactSnapshot }),
    "failed",
  );
  assert.equal(
    resolveDeliverableProgress({ toolName, toolCallOutput, artifactSnapshot })
      ?.status,
    "failed",
  );
});

test("resolveDeliverableElapsedMs uses pipeline wall-clock, not tool latency", () => {
  const startedAt = "2026-07-18T00:00:00.000Z";
  const nowMs = Date.parse("2026-07-18T00:02:15.000Z");
  const steps = buildInitialVideoPresentationPipelineSteps().map((step) =>
    step.id === "planning_storyboard"
      ? {
          ...step,
          status: "completed" as const,
          progress: 100,
          startedAt,
          completedAt: "2026-07-18T00:00:40.000Z",
        }
      : step.id === "generating_audio_tracks"
        ? {
            ...step,
            status: "running" as const,
            progress: 40,
            startedAt: "2026-07-18T00:00:40.000Z",
          }
        : step,
  );

  const elapsed = resolveDeliverableElapsedMs({
    toolName,
    nowMs,
    toolCallOutput: {
      type: "video_presentation_processing_result",
      status: "running",
      stage: "planning_storyboard",
      progress: 0,
    },
    artifactSnapshot: {
      id: "artifact-1",
      status: "running",
      createdAt: startedAt,
      completedAt: null,
      updatedAt: "2026-07-18T00:02:15.000Z",
      payloadJson: {
        generation: {
          status: "running",
          stage: "generating_audio_tracks",
          progress: 42,
          pipelineSteps: steps,
        },
      },
    } as never,
  });

  assert.equal(elapsed, 2 * 60 * 1000 + 15 * 1000);
});

test("resolveDeliverableElapsedMs uses completedAt when terminal", () => {
  const startedAt = "2026-07-18T00:00:00.000Z";
  const completedAt = "2026-07-18T00:05:30.000Z";
  const steps = buildInitialVideoPresentationPipelineSteps().map((step) => ({
    ...step,
    status: "completed" as const,
    progress: 100,
    startedAt,
    completedAt,
  }));

  const elapsed = resolveDeliverableElapsedMs({
    toolName,
    nowMs: Date.parse("2026-07-18T01:00:00.000Z"),
    toolCallOutput: {
      type: "video_presentation_processing_result",
      status: "running",
      stage: "planning_storyboard",
    },
    artifactSnapshot: {
      id: "artifact-1",
      status: "ready",
      createdAt: startedAt,
      completedAt,
      updatedAt: completedAt,
      payloadJson: {
        generation: {
          status: "ready",
          stage: "ready",
          progress: 100,
          pipelineSteps: steps,
        },
      },
    } as never,
  });

  assert.equal(elapsed, 5 * 60 * 1000 + 30 * 1000);
});

test("resolveDeliverableElapsedMs returns null without snapshot timestamps", () => {
  assert.equal(
    resolveDeliverableElapsedMs({
      toolName,
      toolCallOutput: {
        type: "video_presentation_processing_result",
        status: "running",
        stage: "planning_storyboard",
      },
    }),
    null,
  );
});

test("live progress exposes stage display/summary from generation steps", () => {
  const progress = resolveDeliverableProgress({
    toolName,
    toolCallOutput: {
      type: "video_presentation_processing_result",
      artifact_id: "artifact-live",
      status: "running",
      stage: "planning_storyboard",
      progress: 0,
    },
    toolCallStatus: "completed",
    artifactSnapshot: {
      id: "artifact-live",
      status: "running",
      payloadJson: {
        generation: {
          status: "running",
          stage: "planning_storyboard",
          progress: 12,
          pipelineSteps: [
            {
              id: "planning_storyboard",
              label: "Planning storyboard",
              status: "running",
              summary: "Drafting 3 slides",
              display: "# Storyboard\n\n1. **Intro**",
            },
            {
              id: "custom_export",
              label: "Custom export",
              status: "pending",
              display: "Waiting",
            },
          ],
        },
      },
    } as never,
  });

  assert.ok(progress);
  assert.equal(progress.status, "running");
  assert.equal(progress.activeStepId, "planning_storyboard");
  assert.equal(progress.completedStepCount, 0);
  assert.equal(progress.totalStepCount, 2);
  assert.equal(
    progress.steps.find((step) => step.id === "planning_storyboard")?.display,
    "# Storyboard\n\n1. **Intro**",
  );
  assert.equal(
    progress.steps.find((step) => step.id === "planning_storyboard")?.summary,
    "Drafting 3 slides",
  );
  assert.equal(
    progress.steps.find((step) => step.id === "custom_export")?.label,
    "Custom export",
  );
});

test("ready history keeps completed stage display despite stale processing_result", () => {
  const progress = resolveDeliverableProgress({
    toolName,
    toolCallOutput: {
      type: "video_presentation_processing_result",
      artifact_id: "408d52d0-630a-4d28-8bd8-5836ee1c6e87",
      status: "running",
      stage: "planning_storyboard",
      progress: 0,
    },
    toolCallStatus: "completed",
    artifactSnapshot: {
      id: "f55327e0-c10d-489f-b03a-5925d5490349",
      status: "ready",
      payloadJson: {
        generation: {
          status: "ready",
          stage: "ready",
          progress: 100,
          pipelineSteps: [
            {
              id: "planning_storyboard",
              label: "Planning storyboard",
              status: "completed",
              summary: "Planned 2 slides",
              display: "# Storyboard · Demo\n\n1. **Agenda**",
              progress: 100,
            },
            {
              id: "publishing_video_project",
              label: "Publishing video project",
              status: "completed",
              summary: "Published · 12.0s",
              display: "# Published · Demo",
              progress: 100,
            },
          ],
        },
      },
    } as never,
  });

  assert.ok(progress);
  assert.equal(progress.status, "ready");
  assert.equal(progress.activeStepId, null);
  assert.equal(progress.completedStepCount, 2);
  assert.equal(progress.totalStepCount, 2);
  assert.match(
    progress.steps.find((step) => step.id === "planning_storyboard")?.display ??
      "",
    /Agenda/,
  );
});
