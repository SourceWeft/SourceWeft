import assert from "node:assert/strict";
import test from "node:test";
import { validateCanonicalProjectTree } from "../src/pipeline/project-validation";
import {
  VIDEO_VALIDATION_STAGES,
  validateVideoPresentationPresentation as presentation,
} from "../src/presentation";
import { validateVideoPresentationAgentTool } from "../src/agent/agent-tool-defs";

const readField = (output: unknown, key: string) => {
  const value = (output as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : null;
};

test("project validation announces a stage before running its command", async () => {
  const log: string[] = [];
  await validateCanonicalProjectTree({
    execute: async (command) => {
      log.push(`run:${command.split(" ").slice(0, 3).join(" ")}`);
      return { exitCode: 0, output: "" };
    },
    onStage: (stage) => log.push(`stage:${stage}`),
  });
  assert.deepEqual(log, [
    "stage:install",
    "run:pnpm install --frozen-lockfile",
    "stage:typecheck",
    "run:pnpm run build",
    "stage:smoke",
    "run:pnpm run render-smoke",
  ]);
});

test("project validation does not announce stages it will skip", async () => {
  const stages: string[] = [];
  await validateCanonicalProjectTree({
    execute: async (command) => ({
      exitCode: command === "pnpm run build" ? 1 : 0,
      output: "",
    }),
    onStage: (stage) => stages.push(stage),
  });
  assert.deepEqual(stages, ["install", "typecheck"]);
});

test("the validate tool declares its progress presentation", () => {
  assert.equal(validateVideoPresentationAgentTool.presentation, presentation);
  assert.deepEqual(presentation.progressEventTypes, [
    "validate_video_presentation_progress",
  ]);
});

test("every reported stage has display copy and an unknown stage has none", () => {
  for (const stage of VIDEO_VALIDATION_STAGES) {
    const copy = presentation.stageStep?.({ stageId: stage });
    assert.ok(copy, stage);
    assert.equal(copy.phase, "generating");
    assert.ok(copy.item.length > 0);
  }
  assert.equal(presentation.stageStep?.({ stageId: "unheard-of" }), null);
});

test("the validation step stays active, then closes on the verdict", () => {
  const complete = (status: "completed" | "error", output?: unknown) =>
    presentation.artifactCompletionPhase?.({
      toolInput: {},
      toolOutput: output,
      readOutputField: readField,
      status,
    });
  assert.equal(complete("completed", { status: "passed" }), "completed");
  // The call itself completes even when the verdict is a failed validation.
  assert.equal(complete("completed", { status: "failed" }), "failed");
  assert.equal(complete("error"), "failed");

  const active = presentation.generationStep?.({ phase: "generating" });
  assert.equal(active?.stepId, "video-validation");
  assert.equal(active?.title, "Validating video presentation");
  assert.equal(
    presentation.generationStep?.({ phase: "completed" }).title,
    "Video presentation validated",
  );
  assert.equal(
    presentation.generationStep?.({ phase: "failed", error: "boom" })
      .description,
    "boom",
  );
});

test("the card title follows the call status and the verdict", () => {
  const title = (status: "running" | "error" | "completed", output?: unknown) =>
    presentation.title({
      toolInput: {},
      toolOutput: output,
      readOutputField: readField,
      status,
    });
  assert.equal(title("running"), "Validating video presentation");
  assert.equal(title("error"), "Video presentation validation failed");
  assert.equal(
    title("completed", { status: "passed" }),
    "Video presentation validated",
  );
  assert.equal(
    title("completed", { status: "failed" }),
    "Video presentation validation failed",
  );
});
