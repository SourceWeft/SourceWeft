import { z } from "zod";

export const ARTIFACT_PIPELINE_SUMMARY_MAX_CHARS = 240;
export const ARTIFACT_PIPELINE_DISPLAY_MAX_CHARS = 12_000;
export const ARTIFACT_PIPELINE_LOG_TAIL_MAX_LINES = 30;
export const ARTIFACT_PIPELINE_LOG_LINE_MAX_CHARS = 300;
export const ARTIFACT_PIPELINE_IO_JSON_MAX_CHARS = 4_000;

export const artifactPipelineStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export const artifactPipelineGenerationStatusSchema = z.enum([
  "pending",
  "running",
  "ready",
  "failed",
]);

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const artifactPipelineStepSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  status: artifactPipelineStepStatusSchema.default("pending"),
  progress: z.number().min(0).max(100).optional(),
  attempt: z.number().int().min(1).optional(),
  maxAttempts: z.number().int().min(1).optional(),
  errorMessage: z.string().trim().min(1).max(1000).optional(),
  startedAt: z.string().trim().min(1).optional(),
  completedAt: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).max(ARTIFACT_PIPELINE_SUMMARY_MAX_CHARS).optional(),
  display: z
    .string()
    .trim()
    .min(1)
    .max(ARTIFACT_PIPELINE_DISPLAY_MAX_CHARS)
    .optional(),
  input: jsonRecordSchema.optional(),
  output: jsonRecordSchema.optional(),
  logTail: z
    .array(z.string().trim().min(1).max(ARTIFACT_PIPELINE_LOG_LINE_MAX_CHARS))
    .max(ARTIFACT_PIPELINE_LOG_TAIL_MAX_LINES)
    .optional(),
  metrics: z.record(z.string(), z.number()).optional(),
});

export const artifactPipelineGenerationSchema = z.object({
  status: artifactPipelineGenerationStatusSchema.default("pending"),
  stage: z.string().trim().min(1).max(120).optional(),
  progress: z.number().min(0).max(100).default(0),
  attempt: z.number().int().min(1).optional(),
  maxAttempts: z.number().int().min(1).optional(),
  retrying: z.boolean().optional(),
  errorCode: z.string().trim().min(1).max(120).optional(),
  errorMessage: z.string().trim().min(1).max(1000).optional(),
  checkpointStage: z.string().trim().min(1).max(120).optional(),
  pipelineSteps: z.array(artifactPipelineStepSchema).optional(),
});

export type ArtifactPipelineStepStatus = z.infer<
  typeof artifactPipelineStepStatusSchema
>;
export type ArtifactPipelineGenerationStatus = z.infer<
  typeof artifactPipelineGenerationStatusSchema
>;
export type ArtifactPipelineStep = z.infer<typeof artifactPipelineStepSchema>;
export type ArtifactPipelineGeneration = z.infer<
  typeof artifactPipelineGenerationSchema
>;

export function truncatePipelineSummary(
  value: string,
  maxChars = ARTIFACT_PIPELINE_SUMMARY_MAX_CHARS,
) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function truncatePipelineDisplay(
  value: string,
  maxChars = ARTIFACT_PIPELINE_DISPLAY_MAX_CHARS,
) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function appendPipelineLogTail(
  existing: string[] | undefined,
  lines: string[],
  maxLines = ARTIFACT_PIPELINE_LOG_TAIL_MAX_LINES,
  maxLineChars = ARTIFACT_PIPELINE_LOG_LINE_MAX_CHARS,
) {
  const normalized = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line.length <= maxLineChars
        ? line
        : `${line.slice(0, Math.max(0, maxLineChars - 1)).trimEnd()}…`,
    );
  return [...(existing ?? []), ...normalized].slice(-maxLines);
}

export function compactPipelineIo(
  value: Record<string, unknown> | undefined,
  maxChars = ARTIFACT_PIPELINE_IO_JSON_MAX_CHARS,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= maxChars) {
      return value;
    }
    return {
      truncated: true,
      preview: `${encoded.slice(0, Math.max(0, maxChars - 32))}…`,
    };
  } catch {
    return { truncated: true };
  }
}

export type ArtifactPipelineStepPatch = {
  summary?: string;
  display?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  logTail?: string[];
  metrics?: Record<string, number>;
  stepProgress?: number;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
};

export function applyArtifactPipelineStepPatch(
  step: ArtifactPipelineStep,
  patch: ArtifactPipelineStepPatch,
): ArtifactPipelineStep {
  return {
    ...step,
    ...(typeof patch.stepProgress === "number"
      ? { progress: patch.stepProgress }
      : {}),
    ...(typeof patch.attempt === "number" ? { attempt: patch.attempt } : {}),
    ...(typeof patch.maxAttempts === "number"
      ? { maxAttempts: patch.maxAttempts }
      : {}),
    ...(typeof patch.errorMessage === "string"
      ? { errorMessage: patch.errorMessage }
      : {}),
    ...(typeof patch.summary === "string"
      ? { summary: truncatePipelineSummary(patch.summary) }
      : {}),
    ...(typeof patch.display === "string"
      ? { display: truncatePipelineDisplay(patch.display) }
      : {}),
    ...(patch.input
      ? { input: compactPipelineIo(patch.input) ?? patch.input }
      : {}),
    ...(patch.output
      ? { output: compactPipelineIo(patch.output) ?? patch.output }
      : {}),
    ...(patch.logTail
      ? {
          logTail: appendPipelineLogTail(step.logTail, patch.logTail),
        }
      : {}),
    ...(patch.metrics ? { metrics: patch.metrics } : {}),
  };
}

/** Soft cap for SSE/pubsub generation payloads (display already per-step capped). */
export const ARTIFACT_PIPELINE_PUBLISH_MAX_CHARS = 96_000;

/**
 * Shrink a generation for live publish: truncate display, then drop logTail,
 * while keeping summary/status/progress.
 */
export function budgetArtifactPipelineGenerationForPublish<
  T extends ArtifactPipelineGeneration,
>(generation: T, maxChars = ARTIFACT_PIPELINE_PUBLISH_MAX_CHARS): T {
  const encodedSize = () => {
    try {
      return JSON.stringify(generation).length;
    } catch {
      return maxChars + 1;
    }
  };
  if (encodedSize() <= maxChars) {
    return generation;
  }

  const steps = (generation.pipelineSteps ?? []).map((step) => ({ ...step }));
  for (const step of steps) {
    if (typeof step.display === "string" && step.display.length > 1_200) {
      step.display = truncatePipelineDisplay(step.display, 1_200);
    }
  }
  let next = { ...generation, pipelineSteps: steps };
  if (JSON.stringify(next).length <= maxChars) {
    return next;
  }

  next = {
    ...next,
    pipelineSteps: steps.map((step) => {
      const { logTail: _logTail, ...rest } = step;
      return rest;
    }),
  };
  if (JSON.stringify(next).length <= maxChars) {
    return next;
  }

  return {
    ...next,
    pipelineSteps: (next.pipelineSteps ?? []).map((step) => {
      const { display: _display, input: _input, output: _output, ...rest } =
        step;
      return rest;
    }),
  };
}
