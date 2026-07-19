import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_PIPELINE_DISPLAY_MAX_CHARS,
  ARTIFACT_PIPELINE_SUMMARY_MAX_CHARS,
  applyArtifactPipelineStepPatch,
  budgetArtifactPipelineGenerationForPublish,
  truncatePipelineDisplay,
  truncatePipelineSummary,
} from "../src/artifact-pipeline";

test("truncate helpers respect caps", () => {
  const summary = truncatePipelineSummary("x".repeat(ARTIFACT_PIPELINE_SUMMARY_MAX_CHARS + 40));
  assert.ok(summary.length <= ARTIFACT_PIPELINE_SUMMARY_MAX_CHARS);
  assert.ok(summary.endsWith("…"));

  const display = truncatePipelineDisplay(
    "y".repeat(ARTIFACT_PIPELINE_DISPLAY_MAX_CHARS + 80),
  );
  assert.ok(display.length <= ARTIFACT_PIPELINE_DISPLAY_MAX_CHARS);
  assert.ok(display.endsWith("…"));
});

test("applyArtifactPipelineStepPatch keeps summary/display/logTail", () => {
  const patched = applyArtifactPipelineStepPatch(
    {
      id: "custom_stage",
      label: "Custom",
      status: "running",
    },
    {
      summary: "Halfway",
      display: "# Custom output\n\n- item",
      logTail: ["line-1"],
      stepProgress: 50,
      metrics: { n: 1 },
    },
  );
  assert.equal(patched.summary, "Halfway");
  assert.equal(patched.display, "# Custom output\n\n- item");
  assert.deepEqual(patched.logTail, ["line-1"]);
  assert.equal(patched.progress, 50);
  assert.deepEqual(patched.metrics, { n: 1 });
});

test("budgetArtifactPipelineGenerationForPublish keeps summary after shrinking", () => {
  const hugeDisplay = "d".repeat(8_000);
  const generation = {
    status: "running" as const,
    progress: 40,
    stage: "custom_stage",
    pipelineSteps: Array.from({ length: 20 }, (_, index) => ({
      id: `step_${index}`,
      label: `Step ${index}`,
      status: "completed" as const,
      summary: `Summary ${index}`,
      display: hugeDisplay,
      logTail: Array.from({ length: 30 }, (_, line) => `log ${index}:${line}`),
    })),
  };

  const budgeted = budgetArtifactPipelineGenerationForPublish(generation, 20_000);
  assert.equal(budgeted.status, "running");
  assert.equal(budgeted.progress, 40);
  for (const step of budgeted.pipelineSteps ?? []) {
    assert.equal(typeof step.summary, "string");
    assert.ok(!step.logTail || step.logTail.length === 0 || (step.display?.length ?? 0) <= 1_200);
  }
  assert.ok(JSON.stringify(budgeted).length <= 20_000);
});
