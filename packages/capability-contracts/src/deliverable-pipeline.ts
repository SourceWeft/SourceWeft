import { z } from "zod";

/**
 * Deliverable pipeline extension point.
 *
 * A capability tool package that produces its artifact through a background
 * job declares `runtime.pipeline` on the tool contribution and exports a
 * `createDeliverablePipelines` factory (mirroring `createCapabilityAgentTools`
 * for in-turn tools). The backend worker host discovers declarations from
 * manifests, loads the factory, and runs the returned pipeline definition
 * against a narrow injected context — the worker itself stays
 * capability-agnostic.
 *
 * All context typing here is structural and dependency-light (zod only): the
 * backend narrows `llm`/`job.llm` etc. to its concrete gateway types, and
 * packages declare the subset of the context they actually consume.
 */

export const capabilityPipelineSchema = z.object({
  /** BullMQ job name the host registers for this pipeline. */
  jobName: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  queue: z.literal("deliverables").default("deliverables"),
});

export type CapabilityPipelineDeclaration = z.infer<
  typeof capabilityPipelineSchema
>;

/** Job payload fields every deliverable job carries (structural contract). */
export type DeliverableJobEnvelope = {
  readonly artifactId: string;
  readonly jobId: string;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly userMessageId: string;
  readonly title?: string;
  readonly request: Record<string, unknown>;
  readonly traceId?: string;
  readonly parentSpanId?: string;
  readonly toolCallId?: string;
  readonly llm?: unknown;
};

export type DeliverableStageDefinition = {
  readonly id: string;
  readonly label: string;
  readonly budgetMs: number;
  readonly maxAttempts: number;
};

export type DeliverableStepLike = {
  readonly id: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly progress?: number;
};

export type DeliverableStageViewPatch = {
  summary?: string;
  display?: string;
  metrics?: Record<string, number>;
  logTail?: string[];
  stepProgress?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

/**
 * Pipeline-owned error. `retryable: false` stops the host's per-stage retry
 * loop. Hosts must detect this structurally (name/code/retryable) rather than
 * via instanceof: externally-loaded packages may bundle their own copy.
 */
export class DeliverablePipelineError extends Error {
  readonly code: string;
  readonly category: "provider" | "sandbox" | "validation";
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    category: "provider" | "sandbox" | "validation";
    retryable?: boolean;
  }) {
    super(`${input.code}: ${input.message}`);
    this.name = "DeliverablePipelineError";
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable ?? false;
  }
}

export function isDeliverablePipelineErrorLike(
  error: unknown,
): error is Pick<DeliverablePipelineError, "code" | "category" | "retryable"> &
  Error {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean" &&
    ((error as { category?: unknown }).category === "provider" ||
      (error as { category?: unknown }).category === "sandbox" ||
      (error as { category?: unknown }).category === "validation")
  );
}

export type DeliverableLlmInput = {
  messages: Array<Record<string, unknown>>;
  maxTokens?: number;
  metadata: Record<string, unknown>;
  temperature?: number;
};

export type DeliverableStructuredLlmInput = DeliverableLlmInput & {
  schema: Record<string, unknown>;
  schemaName: string;
  validate?: (
    parsed: unknown,
  ) => { ok: true } | { ok: false; feedback: string };
};

export type DeliverableVisionInput = {
  images: Array<{ data: Uint8Array; mimeType: string }>;
  maxTokens?: number;
  metadata: Record<string, unknown>;
  prompt: string;
  temperature?: number;
};

export type DeliverableSandboxExecuteResult = {
  exitCode: number | null;
  output: string;
  truncated?: boolean;
};

export type DeliverableSandboxSession = {
  readonly rootDir: string;
  uploadFiles(
    files: Array<[path: string, content: Uint8Array]>,
  ): Promise<Array<{ path: string; error?: string | null }>>;
  execute(
    command: string,
    options?: { toolCallId?: string },
  ): Promise<DeliverableSandboxExecuteResult>;
  downloadFiles(
    paths: string[],
  ): Promise<Array<{ path: string; content: Uint8Array | null; error?: string | null }>>;
};

export type DeliverableHostLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
};

export type DeliverableHostContext = {
  readonly logger: DeliverableHostLogger;
  readonly llm: {
    complete(input: DeliverableLlmInput): Promise<string>;
    completeStructured(input: DeliverableStructuredLlmInput): Promise<unknown>;
    completeVision?(input: DeliverableVisionInput): Promise<string>;
  };
  readonly tts?: {
    speech(input: {
      text: string;
      metadata: Record<string, unknown>;
    }): Promise<{ audio: Uint8Array; mimeType: string }>;
  };
  /**
   * Structural restatement of `ArtifactStorage` from
   * `@sourceweft/contracts/artifact-storage`, which is the canonical
   * declaration and the one every other site imports. It is inlined here only
   * because this package deliberately carries no workspace dependencies (see
   * the module header); keep the two in sync — they are assignable in both
   * directions today, and that is pinned by a type-level test in the one place
   * that can see both declarations
   * (`apps/backend/src/modules/sources/storage.test.ts`).
   */
  readonly storage: {
    buildArtifactStorageKey(input: {
      artifactId: string;
      fileName: string;
      workspaceId: string;
    }): string;
    getBucketName(): string;
    upload(input: {
      body: Uint8Array;
      contentType: string;
      key: string;
    }): Promise<void>;
    /**
     * Read back an object this port wrote — `null` when the key does not exist.
     * A pipeline stage needs it because per-run `scratch` does not survive a
     * job resume, so bytes an earlier stage uploaded are otherwise gone.
     *
     * `maxBytes` only tightens the port's own ceiling
     * (`ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES`, 25MB); the implementation clamps
     * it, so a pipeline cannot widen how much it may buffer. Exceeding the
     * ceiling throws rather than resolving null — "too big" must not be
     * indistinguishable from "not there".
     */
    download(input: {
      bucket?: string | null;
      key: string;
      maxBytes?: number;
    }): Promise<{ body: Uint8Array; contentType: string } | null>;
  };
  readonly audio: {
    probeDurationSeconds(input: {
      buffer: Uint8Array;
      mimeType: string;
    }): Promise<number | null>;
  };
  /** Resolve user-provided assets (e.g. image artifacts) to raw bytes. */
  readonly assets?: {
    fetchImage(input: {
      assetId: string;
    }): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  /** Generate an image via the platform's default image model (metered). */
  readonly image?: {
    generate(input: {
      prompt: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  readonly sandbox?: {
    createSession(input: {
      sessionKey: string;
    }): Promise<DeliverableSandboxSession | null>;
    /**
     * Resolve platform runtime assets inside a session
     * (docs/architecture/sandbox-runtime-assets.md): the host stages each
     * requested asset through its resolution ladder and reports how. Optional
     * and best-effort by contract — a pipeline must degrade exactly as it
     * would without the asset (the ladder's native rung), never fail on a
     * missing resolver.
     */
    ensureRuntimeAssets?(input: {
      session: DeliverableSandboxSession;
      /** Asset names from the host's catalog (e.g. "chrome-headless-shell"). */
      assets: readonly string[];
    }): Promise<DeliverableRuntimeAssetResolution[]>;
  };
};

/** Outcome of one runtime asset's resolution ladder inside a session. */
export type DeliverableRuntimeAssetResolution = {
  name: string;
  version: string;
  ok: boolean;
  /** Which ladder rung resolved it (absent when ok is false). */
  rung?: "stamp" | "image" | "mount" | "fetch" | "upload";
  /** Absolute path of the asset's entrypoint inside the sandbox. */
  entrypointPath?: string;
  ms: number;
  bytes?: number;
  error?: string;
};

export type DeliverableRunMode = "create" | "edit";

export type DeliverableStageRunInput<TState> = {
  stageId: string;
  state: TState;
  ctx: DeliverableHostContext;
  job: DeliverableJobEnvelope;
  prepared: unknown;
  /**
   * Per-job mutable scratch shared across stages but never persisted (e.g.
   * sandbox run results consumed by later verification stages). Resumed jobs
   * start with an empty scratch.
   */
  scratch: Record<string, unknown>;
  api: {
    updateStageProgress(patch: DeliverableStageViewPatch): Promise<void>;
    /**
     * Declare the artifact's thumbnail. The stage must have uploaded the bytes
     * to `storageKey` itself; the host persists the pointer onto the artifact
     * record when the run publishes. Last call wins; never calling it leaves
     * whatever thumbnail the artifact already has.
     */
    setPreviewImage(image: DeliverablePreviewImage): void;
  };
};

/**
 * Pointer to an already-uploaded artifact thumbnail. The same artifact columns
 * back every artifact type, whether the bytes come from a publisher tool or a
 * generation pipeline.
 */
export type DeliverablePreviewImage = {
  storageKey: string;
  metadata: {
    altText?: string;
    byteLength?: number;
    fileName: string;
    mimeType: string;
  };
};

export type DeliverablePipelineDefinition<
  TState extends { generation: Record<string, unknown> } = {
    generation: Record<string, unknown>;
  },
> = {
  /** Stable pipeline id — logs and the default billing feature. */
  readonly id: string;
  /** Must equal the manifest's runtime.pipeline.jobName. */
  readonly jobName: string;
  readonly artifactType: string;
  readonly stages: readonly DeliverableStageDefinition[];
  readonly defaultErrorCode: string;
  readonly invalidPayloadErrorCode: string;
  readonly billing?: { feature?: string };
  readonly config?: Record<string, unknown>;
  /** Parse/validate the job request before any artifact state is touched. */
  prepareJob(job: DeliverableJobEnvelope): unknown;
  /** Parse the persisted artifact payload into pipeline state (throws DeliverablePipelineError on invalid payload). */
  loadState(artifactPayload: unknown): TState;
  /**
   * Optional per-run transform after loadState. An "edit" run regenerates an
   * already-published artifact in place: the host then keeps the artifact's
   * current version untouched while running (no intermediate payload writes,
   * no markFailed on error) and only publishes a new version on success.
   * Create runs (default) persist progress and mark failures as today.
   */
  prepareRun?(input: {
    job: DeliverableJobEnvelope;
    prepared: unknown;
    state: TState;
  }): { state: TState; mode: DeliverableRunMode };
  buildStageView(stageId: string, state: TState): DeliverableStageViewPatch;
  /** Override when clients recompute progress from a shared function (video). */
  computeOverallProgress?(steps: readonly DeliverableStepLike[]): number;
  runStage(input: DeliverableStageRunInput<TState>): Promise<TState>;
  /** Build the final artifact payload persisted by markReady. */
  finalize(input: {
    state: TState;
    job: DeliverableJobEnvelope;
  }): Record<string, unknown>;
};

/**
 * Entry-module contract: deliverable-capable packages export this factory
 * (analogous to createCapabilityAgentTools for in-turn tools).
 */
export type CreateDeliverablePipelines = (input: {
  manifest: unknown;
}) =>
  | readonly DeliverablePipelineDefinition[]
  | Promise<readonly DeliverablePipelineDefinition[]>;
