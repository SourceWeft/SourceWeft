import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createBudgetWeightedProgress,
  createDeliverableStageRunner,
  runStageWithBudget,
  type DeliverableStateLike,
} from "./stage-runner";

const STAGES = [
  { id: "plan", label: "Plan", budgetMs: 60_000, maxAttempts: 2 },
  { id: "build", label: "Build", budgetMs: 180_000, maxAttempts: 2 },
  { id: "publish", label: "Publish", budgetMs: 60_000, maxAttempts: 1 },
] as const;

test("budget-weighted progress caps at 99 until every step completes", () => {
  const compute = createBudgetWeightedProgress([...STAGES]);
  const steps = (
    statuses: Array<"pending" | "running" | "completed">,
  ) =>
    STAGES.map((stage, index) => ({
      id: stage.id,
      label: stage.label,
      status: statuses[index]!,
    }));

  assert.equal(compute(steps(["pending", "pending", "pending"])), 0);
  assert.equal(compute(steps(["completed", "pending", "pending"])), 20);
  assert.equal(compute(steps(["completed", "completed", "pending"])), 80);
  assert.equal(compute(steps(["completed", "completed", "running"])), 80);
  assert.equal(compute(steps(["completed", "completed", "completed"])), 100);
});

test("runner advances steps, checkpoints, and skips completed stages", () => {
  const runner = createDeliverableStageRunner({ stages: [...STAGES] });
  const initial: DeliverableStateLike = {
    generation: {
      status: "pending",
      stage: "plan",
      progress: 0,
    },
  };

  const started = runner.advanceStep(initial, {
    action: "start",
    stageId: "plan",
  });
  assert.equal(started.generation.status, "running");
  assert.equal(started.generation.pipelineSteps?.[0]?.status, "running");

  const completed = runner.advanceStep(started, {
    action: "complete",
    stageId: "plan",
  });
  assert.equal(completed.generation.checkpointStage, "plan");
  assert.ok(
    runner.shouldSkipStage({ checkpointStage: "plan", stageId: "plan" }),
  );
  assert.ok(
    !runner.shouldSkipStage({ checkpointStage: "plan", stageId: "build" }),
  );

  const ready = runner.markReady(completed);
  assert.equal(ready.generation.status, "ready");
  assert.equal(ready.generation.progress, 100);
  assert.equal(ready.generation.checkpointStage, "publish");

  const failed = runner.markFailed(started, {
    errorCode: "X_FAILED",
    errorMessage: "boom",
  });
  assert.equal(failed.generation.status, "failed");
  assert.equal(failed.generation.errorCode, "X_FAILED");
});

test("structurally non-retryable errors stop the retry loop", async () => {
  let attempts = 0;
  await assert.rejects(
    runStageWithBudget({
      config: { budgetMs: 60_000, maxAttempts: 3 },
      stageId: "build",
      fn: async () => {
        attempts += 1;
        throw Object.assign(new Error("PIPELINE_X: nope"), {
          code: "PIPELINE_X",
          retryable: false,
        });
      },
    }),
    /nope/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  await assert.rejects(
    runStageWithBudget({
      config: { budgetMs: 60_000, maxAttempts: 3 },
      stageId: "build",
      fn: async () => {
        attempts += 1;
        throw Object.assign(new Error("generated content invalid"), {
          code: "GENERATED_CONTENT_INVALID",
          retryable: true,
        });
      },
    }),
    /generated content invalid/,
  );
  assert.equal(attempts, 3);
});
