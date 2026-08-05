import {
  DeliverablePipelineError,
  type DeliverableHostContext,
  type DeliverableHostLogger,
  type DeliverableJobEnvelope,
} from "@sourceweft/capability-contracts";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import {
  VIDEO_PRESENTATION_ERROR_CODES,
  type VideoPresentationCreateRequest,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import { videoPresentationSandboxError } from "./errors";
import { CHROME_HEADLESS_SHELL_ASSET } from "./renderer-version";
import {
  runProjectInSession,
  type RenderedVideoResult,
  type RenderVideoRequest,
} from "./sandbox-project";

/**
 * Structural chat message type. The pipeline only ever constructs
 * `{ role, content }` messages; the host adapts them onto its own gateway
 * message type (no model-gateway dependency here).
 */
export type WorkerChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type WorkerLlmInput = {
  messages: WorkerChatMessage[];
  maxTokens?: number;
  metadata: Record<string, unknown>;
  temperature?: number;
};

export type StructuredValidationVerdict =
  | { ok: true }
  | { ok: false; feedback: string };

export type WorkerStructuredLlmInput = WorkerLlmInput & {
  schema: Record<string, unknown>;
  schemaName: string;
  /**
   * Optional acceptance check on the parsed structured output. When it rejects,
   * completeStructured makes exactly one repair call on the same model with the
   * returned feedback before giving up.
   */
  validate?: (parsed: unknown) => StructuredValidationVerdict;
};

export type ProjectExecutionResult = {
  ok: boolean;
  diagnostics: string[];
  stdout?: string;
  stderr?: string;
};

export type VideoPipelineDeps = {
  logger: DeliverableHostLogger;
  llm: {
    complete(input: WorkerLlmInput): Promise<string>;
    completeStructured(input: WorkerStructuredLlmInput): Promise<unknown>;
    /**
     * Judge rendered slide stills with the default vision model. Optional:
     * when absent (or no vision profile is configured) the visual QA stage
     * degrades to a no-op.
     */
    completeVision?(input: {
      images: Array<{ data: Uint8Array; mimeType: string }>;
      maxTokens?: number;
      metadata: Record<string, unknown>;
      prompt: string;
      temperature?: number;
    }): Promise<string>;
  };
  tts: {
    speech(input: {
      metadata: Record<string, unknown>;
      text: string;
    }): Promise<{ audio: Uint8Array; mimeType: string }>;
  };
  storage: ArtifactStorage;
  audio: {
    probeDurationSeconds(input: {
      buffer: Uint8Array;
      mimeType: string;
    }): Promise<number | null>;
  };
  assets: {
    fetchImage(input: {
      assetId: string;
    }): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  image?: {
    generate(input: {
      prompt: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ data: Uint8Array; mimeType: string } | null>;
  };
  sandbox?: {
    runProject(input: {
      payload: VideoPresentationProjectPayload;
      request: VideoPresentationCreateRequest;
      job: DeliverableJobEnvelope;
      /**
       * Opt-in server-side mp4 render, passed by the `installing_project`
       * stage. It is omitted when narration could not be assembled in full, so
       * leaving it unset must keep the run exactly as it was before this path
       * existed — that omission is the degradation.
       */
      renderVideo?: RenderVideoRequest;
    }): Promise<{
      install: ProjectExecutionResult;
      typecheck: ProjectExecutionResult;
      smoke: ProjectExecutionResult;
      stills?: Array<{ slideNumber: number; data: Uint8Array }>;
      video?: RenderedVideoResult;
    }>;
  };
};

/** Map the generic deliverable host context onto the pipeline's deps 1:1. */
export function createVideoPipelineDeps(
  ctx: DeliverableHostContext,
  overrides?: {
    runProject?: NonNullable<VideoPipelineDeps["sandbox"]>["runProject"];
  },
): VideoPipelineDeps {
  return {
    logger: ctx.logger,
    llm: ctx.llm,
    assets: ctx.assets ?? {
      fetchImage: async () => null,
    },
    ...(ctx.image ? { image: ctx.image } : {}),
    tts: ctx.tts ?? {
      speech: async () => {
        throw new DeliverablePipelineError({
          code: VIDEO_PRESENTATION_ERROR_CODES.generationFailed,
          message: "TTS is not configured for this deployment.",
          category: "provider",
        });
      },
    },
    storage: ctx.storage,
    audio: ctx.audio,
    sandbox: overrides?.runProject
      ? { runProject: overrides.runProject }
      : ctx.sandbox
        ? {
            runProject: async (runInput) => {
              const session = await ctx.sandbox!.createSession({
                sessionKey: runInput.job.toolCallId ?? runInput.job.jobId,
              });
              if (!session) {
                throw videoPresentationSandboxError(
                  VIDEO_PRESENTATION_ERROR_CODES.sandboxUnavailable,
                  "The configured sandbox runtime is disabled or unavailable.",
                );
              }
              // Stage the render browser through the host's runtime-asset
              // ladder. Best-effort by contract: any failure (no resolver, no
              // cache, ladder exhausted) leaves the path unset and the render
              // scripts fall back to Remotion's own download — the ladder's
              // native rung.
              let browserExecutablePath: string | undefined;
              if (ctx.sandbox!.ensureRuntimeAssets) {
                try {
                  const resolutions = await ctx.sandbox!.ensureRuntimeAssets({
                    session,
                    assets: [CHROME_HEADLESS_SHELL_ASSET.name],
                  });
                  const browser = resolutions.find(
                    (resolution) =>
                      resolution.name === CHROME_HEADLESS_SHELL_ASSET.name,
                  );
                  if (browser?.ok && browser.entrypointPath) {
                    browserExecutablePath = browser.entrypointPath;
                  }
                  for (const resolution of resolutions) {
                    ctx.logger[resolution.ok ? "info" : "warn"](
                      "video_presentation_runtime_asset",
                      {
                        artifactId: runInput.job.artifactId,
                        jobId: runInput.job.jobId,
                        ...resolution,
                      },
                    );
                  }
                } catch (error) {
                  ctx.logger.warn("video_presentation_runtime_asset_failed", {
                    artifactId: runInput.job.artifactId,
                    jobId: runInput.job.jobId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              }
              return runProjectInSession({
                session,
                logger: ctx.logger,
                job: runInput.job,
                payload: runInput.payload,
                ...(browserExecutablePath ? { browserExecutablePath } : {}),
                ...(runInput.renderVideo
                  ? { renderVideo: runInput.renderVideo }
                  : {}),
              });
            },
          }
        : undefined,
  };
}
