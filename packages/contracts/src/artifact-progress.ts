import {
  artifactPipelineGenerationSchema,
  artifactPipelineGenerationStatusSchema,
  type ArtifactPipelineGeneration,
  type ArtifactPipelineGenerationStatus,
  type ArtifactPipelineStep,
} from "./artifact-pipeline";

/**
 * Generic protocol for artifact progress tracking.
 * Tool packages implement this to enable standardized progress management
 * without requiring web-side customization.
 */
export interface ArtifactProgressProtocol {
  /**
   * Extract the artifact ID from tool output.
   * Returns null if no artifact ID is present.
   */
  extractArtifactId(output: unknown): string | null;

  /**
   * Determine whether this artifact requires progress tracking.
   * Returns true for pending/running states that need SSE + polling.
   *
   * @param output - Tool call output
   * @param snapshot - Current artifact snapshot (if available)
   */
  isProgressTracking(
    output: unknown,
    snapshot?: { status: string; payloadJson?: unknown } | null,
  ): boolean;

  /**
   * Determine whether this artifact is in a terminal state.
   * Returns true for ready/failed/archived states that don't need polling.
   *
   * @param snapshot - Current artifact snapshot
   */
  isTerminal(
    snapshot?: { status: string; payloadJson?: unknown } | null,
  ): boolean;

  /** Human-readable name of what is being produced. */
  readonly title: string;

  /** Structured tool-output `type` values this capability emits. */
  readonly outputTypes: readonly string[];

  /**
   * The role each of those `type` values plays, so generic callers can ask
   * "is this the final result?" instead of matching capability-specific names.
   */
  readonly outputTypeRoles: Readonly<Record<string, ArtifactProgressOutputRole>>;

  /**
   * Whether a structured tool output belongs to this capability. Lets the UI
   * suppress a raw output summary it is going to render as progress instead.
   */
  matchesOutputType(output: unknown): boolean;

  /**
   * The steps and status to render. Capability-agnostic callers go through
   * this rather than reaching for capability-specific modules.
   */
  resolveProgressView(input: ArtifactProgressInput): ArtifactProgressView;

  /**
   * Wall-clock duration of the background job (pipeline start → now or
   * terminal), not the fire-and-forget tool call that launched it.
   */
  resolveElapsedMs(input: ArtifactProgressInput & { nowMs?: number }): number | null;
}

/**
 * Pending artifact reference for controller-level tracking.
 */
export interface PendingArtifactRef {
  artifactId: string;
  toolName: string;
}

// ---------------------------------------------------------------------------
// Generic progress reading
// ---------------------------------------------------------------------------

/**
 * Everything needed to render a deliverable's progress, derived from the
 * generic `generation` block the deliverable host writes for every pipeline.
 *
 * There is deliberately no overall percentage here. The host's stage table is
 * the only thing that knows how long a stage takes, and any single number it
 * produces is a guess that disagrees with what the user sees. Step counts are
 * honest: "4 of 11 done" needs no weighting and cannot drift from the steps
 * rendered beside it.
 */
export interface ArtifactProgressView {
  steps: ArtifactPipelineStep[];
  activeStepId: string | null;
  completedStepCount: number;
  totalStepCount: number;
  status: ArtifactPipelineGenerationStatus;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * What a capability's structured output says about the job it reports on.
 *
 * Generic callers need this because the three questions they ask — "did the
 * job finish?", "was it merely accepted for processing?", "is this just a
 * progress tick?" — cannot be answered by membership alone. Naming the role
 * here keeps the answer with the capability that knows it, instead of forcing
 * every consumer to hardcode the capability's `type` strings.
 *
 * - `processing`: the job was accepted and is running in the background.
 * - `terminal`: the job finished; the record carries the final status.
 * - `progress`: an intermediate tick with no outcome of its own (the default
 *   for a bare string, which claims nothing beyond membership).
 */
export type ArtifactProgressOutputRole = "progress" | "processing" | "terminal";

/** An output `type` together with the role it plays, or just the type. */
export type ArtifactProgressOutputTypeSpec =
  | string
  | { type: string; role: ArtifactProgressOutputRole };

/** Capability-specific facts the generic reader cannot infer. */
export interface ArtifactProgressDescriptor {
  /** Human-readable name of what is being produced, e.g. "Video presentation". */
  title: string;
  /**
   * Structured tool-output `type` values this capability emits. A bare string
   * declares membership only; the object form additionally states the role.
   */
  outputTypes: readonly ArtifactProgressOutputTypeSpec[];
  /** Steps to show before the first payload arrives. */
  initialSteps(): ArtifactPipelineStep[];
}

/** The declared `type` values, stripped of their roles. */
export function readArtifactProgressOutputTypes(
  descriptor: ArtifactProgressDescriptor,
): readonly string[] {
  return descriptor.outputTypes.map((spec) =>
    typeof spec === "string" ? spec : spec.type,
  );
}

/** The declared `type` values keyed by role; bare strings default to `progress`. */
export function readArtifactProgressOutputTypeRoles(
  descriptor: ArtifactProgressDescriptor,
): Readonly<Record<string, ArtifactProgressOutputRole>> {
  const roles: Record<string, ArtifactProgressOutputRole> = {};
  for (const spec of descriptor.outputTypes) {
    if (typeof spec === "string") {
      roles[spec] = "progress";
    } else {
      roles[spec.type] = spec.role;
    }
  }
  return roles;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Tool output reaches the UI in several shapes: the structured record itself,
 * a JSON string, or a LangChain message whose payload sits in a `content` /
 * `displayContent` string. Reading only top-level keys silently misses the
 * wrapped forms, so unwrap once here and let every reader work on the result.
 */
function normalizeToolOutput(output: unknown): Record<string, unknown> | null {
  const direct = readRecord(output);
  const raw =
    typeof output === "string"
      ? output
      : typeof direct?.displayContent === "string"
        ? direct.displayContent
        : typeof direct?.content === "string"
          ? direct.content
          : null;

  if (raw && raw.trim().startsWith("{")) {
    try {
      const parsed = readRecord(JSON.parse(raw.trim()));
      if (parsed) {
        // A wrapped payload wins only where it actually carries the field; the
        // outer record still supplies anything the inner one omits.
        return direct ? { ...direct, ...parsed } : parsed;
      }
    } catch {
      // Not JSON after all — fall through to the outer record.
    }
  }

  return direct;
}

export function readArtifactGeneration(
  payload: unknown,
): ArtifactPipelineGeneration | null {
  const generation = normalizeToolOutput(payload)?.generation;
  if (!generation) {
    return null;
  }
  const parsed = artifactPipelineGenerationSchema.safeParse(generation);
  return parsed.success ? parsed.data : null;
}

export function readArtifactOutputField(output: unknown, key: string) {
  const value = normalizeToolOutput(output)?.[key];
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : null;
}

export function extractArtifactIdFromOutput(output: unknown): string | null {
  return (
    readArtifactOutputField(output, "artifact_id") ??
    readArtifactOutputField(output, "artifactId")
  );
}

/** A persisted tool row is too stale to trust for live progress. */
function isToolCallComplete(status?: string) {
  return status === "completed" || status === "error";
}

export interface ArtifactProgressInput {
  toolCallOutput?: unknown;
  toolCallStatus?: string;
  artifactSnapshot?: {
    status?: string;
    payloadJson?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
  } | null;
}

export function resolveArtifactGenerationStatus(
  input: ArtifactProgressInput,
): ArtifactPipelineGenerationStatus | null {
  const fromPayload = readArtifactGeneration(
    input.artifactSnapshot?.payloadJson,
  );
  if (fromPayload) {
    return fromPayload.status;
  }

  const rowStatus = artifactPipelineGenerationStatusSchema.safeParse(
    input.artifactSnapshot?.status === "processing"
      ? "running"
      : input.artifactSnapshot?.status,
  );

  if (extractArtifactIdFromOutput(input.toolCallOutput)) {
    // The snapshot is authoritative once it exists. A fire-and-forget tool row
    // says "running" forever and must never override it; before the snapshot
    // loads, keep showing progress rather than falling through to a stale
    // "ready" in the tool output.
    return rowStatus.success ? rowStatus.data : "running";
  }

  if (rowStatus.success && (rowStatus.data === "ready" || rowStatus.data === "failed")) {
    return rowStatus.data;
  }

  if (!isToolCallComplete(input.toolCallStatus)) {
    const outputStatus = artifactPipelineGenerationStatusSchema.safeParse(
      readArtifactOutputField(input.toolCallOutput, "status") === "processing"
        ? "running"
        : readArtifactOutputField(input.toolCallOutput, "status"),
    );
    if (outputStatus.success) {
      return outputStatus.data;
    }
  }

  return rowStatus.success ? rowStatus.data : null;
}

export function resolveArtifactProgressView(
  input: ArtifactProgressInput & { descriptor: ArtifactProgressDescriptor },
): ArtifactProgressView {
  const status = resolveArtifactGenerationStatus(input) ?? "pending";
  const fromSnapshot = readArtifactGeneration(
    input.artifactSnapshot?.payloadJson,
  );
  // Completed tool rows keep a forever-stale payload; only consult tool output
  // while the call is live or no snapshot has arrived yet.
  const mayUseToolOutput =
    !isToolCallComplete(input.toolCallStatus) || !input.artifactSnapshot;
  const fromOutput = mayUseToolOutput
    ? readArtifactGeneration(input.toolCallOutput)
    : null;
  const generation = fromSnapshot ?? fromOutput;

  let steps =
    generation?.pipelineSteps && generation.pipelineSteps.length > 0
      ? generation.pipelineSteps
      : input.descriptor.initialSteps();

  if (status === "ready") {
    steps = steps.map((step) =>
      step.status === "completed"
        ? step
        : { ...step, status: "completed" as const },
    );
  } else if (
    (status === "running" || status === "pending") &&
    !steps.some((step) => step.status === "running")
  ) {
    // Show the next pending step as active so the UI never looks stalled
    // between a stage completing and the next one reporting.
    const nextPending = steps.findIndex((step) => step.status === "pending");
    if (nextPending >= 0) {
      steps = steps.map((step, index) =>
        index === nextPending ? { ...step, status: "running" as const } : step,
      );
    }
  }

  return {
    steps,
    activeStepId: steps.find((step) => step.status === "running")?.id ?? null,
    completedStepCount: steps.filter((step) => step.status === "completed")
      .length,
    totalStepCount: steps.length,
    status,
    ...(generation?.errorCode ??
    input.artifactSnapshot?.errorCode ??
    readArtifactOutputField(input.toolCallOutput, "error_code") ??
    readArtifactOutputField(input.toolCallOutput, "errorCode")
      ? {
          errorCode:
            generation?.errorCode ??
            input.artifactSnapshot?.errorCode ??
            readArtifactOutputField(input.toolCallOutput, "error_code") ??
            readArtifactOutputField(input.toolCallOutput, "errorCode") ??
            undefined,
        }
      : {}),
    ...(generation?.errorMessage ??
    input.artifactSnapshot?.errorMessage ??
    readArtifactOutputField(input.toolCallOutput, "error_message") ??
    readArtifactOutputField(input.toolCallOutput, "errorMessage")
      ? {
          errorMessage:
            generation?.errorMessage ??
            input.artifactSnapshot?.errorMessage ??
            readArtifactOutputField(input.toolCallOutput, "error_message") ??
            readArtifactOutputField(input.toolCallOutput, "errorMessage") ??
            undefined,
        }
      : {}),
  };
}

/**
 * Wall-clock duration of the background job, derived from step timestamps the
 * host records. Falls back to the artifact row's createdAt when no step has
 * started yet, so the timer starts when the job was queued rather than showing
 * nothing.
 */
export function resolveArtifactElapsedMs(
  input: ArtifactProgressInput & { nowMs?: number },
): number | null {
  const generation = readArtifactGeneration(input.artifactSnapshot?.payloadJson);
  const now = input.nowMs ?? Date.now();

  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const step of generation?.pipelineSteps ?? []) {
    const started = step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
    if (Number.isFinite(started)) {
      startMs = startMs === null ? started : Math.min(startMs, started);
    }
    const completed = step.completedAt ? Date.parse(step.completedAt) : Number.NaN;
    if (Number.isFinite(completed)) {
      endMs = endMs === null ? completed : Math.max(endMs, completed);
    }
  }

  const snapshot = input.artifactSnapshot as
    | { createdAt?: string; completedAt?: string; updatedAt?: string }
    | null
    | undefined;

  if (startMs === null && snapshot?.createdAt) {
    const parsed = Date.parse(snapshot.createdAt);
    if (Number.isFinite(parsed)) {
      startMs = parsed;
    }
  }
  if (startMs === null) {
    return null;
  }

  const status = resolveArtifactGenerationStatus(input);
  if (status === "pending" || status === "running") {
    endMs = now;
  } else if (endMs === null) {
    for (const candidate of [snapshot?.completedAt, snapshot?.updatedAt]) {
      const parsed = candidate ? Date.parse(candidate) : Number.NaN;
      if (Number.isFinite(parsed)) {
        endMs = parsed;
        break;
      }
    }
  }

  return endMs === null ? null : Math.max(0, endMs - startMs);
}

/**
 * Builds the protocol from the two capability-specific facts. Every deliverable
 * writes the same `generation` block, so hand-rolling these methods per package
 * only duplicates the reading of it.
 */
export function createArtifactProgressProtocol(
  descriptor: ArtifactProgressDescriptor,
): ArtifactProgressProtocol & { descriptor: ArtifactProgressDescriptor } {
  const outputTypes = readArtifactProgressOutputTypes(descriptor);
  return {
    descriptor,
    title: descriptor.title,
    outputTypes,
    outputTypeRoles: readArtifactProgressOutputTypeRoles(descriptor),
    extractArtifactId: extractArtifactIdFromOutput,
    matchesOutputType(output) {
      const outputType = readArtifactOutputField(output, "type");
      return outputType !== null && outputTypes.includes(outputType);
    },
    resolveProgressView(input) {
      return resolveArtifactProgressView({ ...input, descriptor });
    },
    resolveElapsedMs(input) {
      return resolveArtifactElapsedMs(input);
    },
    isProgressTracking(output, snapshot) {
      if (!extractArtifactIdFromOutput(output)) {
        return false;
      }
      const status = resolveArtifactGenerationStatus({
        toolCallOutput: output,
        artifactSnapshot: snapshot,
      });
      if (status) {
        return status === "pending" || status === "running";
      }
      const outputType = readArtifactOutputField(output, "type");
      return outputType !== null && outputTypes.includes(outputType);
    },
    isTerminal(snapshot) {
      if (!snapshot) {
        return false;
      }
      // `archived` is an artifact-row state with no generation counterpart, so
      // it is checked here rather than in the generation status reader.
      if (snapshot.status === "archived") {
        return true;
      }
      const status = resolveArtifactGenerationStatus({
        artifactSnapshot: snapshot,
      });
      return status === "ready" || status === "failed";
    },
  };
}
