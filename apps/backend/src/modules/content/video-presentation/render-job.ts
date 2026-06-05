import type {
  VideoPresentationRenderJobPayload,
  VideoPresentationRenderJobResult,
} from "../queue";
import {
  markArtifactFailed,
  markArtifactRunning,
  markVideoPresentationArtifactReady,
  findArtifactRecord,
} from "../artifacts/repository";
import { logger } from "../../../shared/logger";
import { billingService } from "../../billing";
import type { ContentBillingPort } from "../billing-port";
import { planVideoPresentationSpec } from "./planner";
import { generateVideoPresentationNarrationAudio } from "./audio";
import {
  compactVideoPresentationText,
  buildVideoPresentationProjectFileName,
  getSlideDurationSeconds,
  getVideoDurationSeconds,
  stripRenderOnlyAudioFields,
  stripVideoPresentationMarkdown,
  type RenderableVideoPresentationSpec,
} from "./spec";

export type VideoPresentationProjectStageEvent =
  | { stage: "planning"; status: "running" }
  | { stage: "planning_started"; status: "running" }
  | { stage: "planning_completed"; status: "running" }
  | { stage: "generating_audio"; status: "running" }
  | { stage: "audio_generation_started"; status: "running" }
  | { stage: "audio_generation_completed"; status: "running" }
  | { stage: "audio_slide_started"; status: "running" }
  | { stage: "audio_slide_completed"; status: "running" }
  | { stage: "finalizing_project"; status: "running" }
  | { stage: "project_finalizing"; status: "running" }
  | { stage: "project_ready"; status: "ready" }
  | { stage: "failed"; status: "failed" }
  | { stage: "project_failed"; status: "failed" };

const VIDEO_PRESENTATION_PROJECT_TIMEOUT_MS = 4 * 60_000;

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message.split("\n", 1)[0]?.slice(0, 500) || error.name;
  }
  return String(error).slice(0, 500);
}

function resolveVideoRenderErrorCode(error: unknown) {
  return error instanceof Error && error.name === "VideoPresentationRenderTimeoutError"
    ? "VIDEO_PRESENTATION_RENDER_TIMEOUT"
    : "VIDEO_PRESENTATION_RENDER_FAILED";
}

function createTimeoutError(timeoutMs: number) {
  const error = new Error(
    `Video presentation project generation timed out after ${Math.round(
      timeoutMs / 1000,
    )}s.`,
  );
  error.name = "VideoPresentationRenderTimeoutError";
  return error;
}

async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutError = createTimeoutError(timeoutMs);
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function buildRunningPayload(input: VideoPresentationRenderJobPayload) {
  return {
    title: input.title,
    prompt:
      input.userPrompt ??
      compactVideoPresentationText(
        stripVideoPresentationMarkdown(input.sourceContent),
      ),
    artifactKind: "video_presentation",
    renderStrategy: "frontend_remotion_project_to_video",
    videoDownloadOnly: true,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    fileName: buildVideoPresentationProjectFileName(input.title),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    generation: {
      status: "running",
      stage: "planning",
    },
    narrationEnabled: input.narrationEnabled,
    source: {
      contentPreview: compactVideoPresentationText(
        stripVideoPresentationMarkdown(input.sourceContent),
        1200,
      ),
      userPrompt: input.userPrompt,
    },
  };
}

function buildFailedPayload(input: {
  currentPayload: Record<string, unknown>;
  errorCode: string;
  errorMessage: string;
}) {
  return {
    ...input.currentPayload,
    generation: {
      status: "failed",
      stage: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    },
  };
}

function buildProjectManifest(input: {
  spec: RenderableVideoPresentationSpec;
  fileName: string;
  title: string;
}) {
  return {
    schemaVersion: 1,
    artifactKind: "video_presentation",
    renderStrategy: "frontend_remotion_project_to_video",
    title: input.title,
    fps: input.spec.fps,
    width: input.spec.width,
    height: input.spec.height,
    theme: input.spec.theme,
    durationSeconds: getVideoDurationSeconds(input.spec),
    narrationEnabled: input.spec.narrationEnabled,
    videoDownloadOnly: true,
    fileName: input.fileName,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    audioTracks: stripRenderOnlyAudioFields(input.spec.audioTracks),
    slides: input.spec.slides,
    scenes: input.spec.scenes,
    slideTiming: input.spec.slides.map((slide) => ({
      durationSeconds: getSlideDurationSeconds(input.spec, slide.slideNumber),
      slideNumber: slide.slideNumber,
    })),
    spec: {
      ...input.spec,
      audioTracks: stripRenderOnlyAudioFields(input.spec.audioTracks),
    },
  };
}

function logVideoProjectStage(
  payload: VideoPresentationRenderJobPayload,
  stage: string,
  metadata?: Record<string, unknown>,
) {
  logger.info("Video presentation project stage", {
    artifactId: payload.artifactId,
    elapsedMs: metadata?.elapsedMs,
    jobId: payload.jobId,
    requestKey: payload.requestKey,
    stage,
    teamId: payload.teamId,
    threadId: payload.threadId,
    toolCallId: payload.toolCallId,
    userId: payload.userId,
    userMessageId: payload.userMessageId,
    workspaceId: payload.workspaceId,
    ...metadata,
  });
}

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

async function markVideoArtifactRunningOrAbort(
  input: Parameters<typeof markArtifactRunning>[0],
) {
  const claimed = await markArtifactRunning(input);
  if (!claimed) {
    throw new Error("Video presentation artifact is no longer pending.");
  }
}

export async function processVideoPresentationRenderJob(
  payload: VideoPresentationRenderJobPayload,
  deps: {
    billing?: ContentBillingPort;
    planner?: typeof planVideoPresentationSpec;
    audioGenerator?: typeof generateVideoPresentationNarrationAudio;
    onStage?: (
      event: VideoPresentationProjectStageEvent,
      metadata?: Record<string, unknown>,
    ) => void | Promise<void>;
  } = {},
): Promise<VideoPresentationRenderJobResult> {
  const startedAt = Date.now();
  return withAbortTimeout(
    (signal) => processVideoPresentationRenderJobCore(payload, {
      ...deps,
      signal,
      startedAt,
    }),
    VIDEO_PRESENTATION_PROJECT_TIMEOUT_MS,
  ).catch(async (error) => {
    const message = errorMessage(error);
    const errorCode = resolveVideoRenderErrorCode(error);
    const artifact = await findArtifactRecord({
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      artifactId: payload.artifactId,
    });
    const currentPayload =
      artifact?.payloadJson && typeof artifact.payloadJson === "object"
        ? (artifact.payloadJson as Record<string, unknown>)
        : buildRunningPayload(payload);
    logVideoProjectStage(payload, "project_failed", {
      elapsedMs: elapsedMs(startedAt),
      errorCode,
      errorMessage: message,
    });
    await markArtifactFailed({
      artifactId: payload.artifactId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      expectedStatuses: ["pending", "running"],
      errorCode,
      errorMessage: message,
      payload: buildFailedPayload({
        currentPayload,
        errorCode,
        errorMessage: message,
      }),
    });
    await deps.onStage?.(
      { stage: "project_failed", status: "failed" },
      {
        elapsedMs: elapsedMs(startedAt),
        errorCode,
        errorMessage: message,
      },
    );
    return {
      status: "failed",
      artifactId: payload.artifactId,
      errorCode,
      errorMessage: message,
    };
  });
}

async function processVideoPresentationRenderJobCore(
  payload: VideoPresentationRenderJobPayload,
  deps: {
    billing?: ContentBillingPort;
    planner?: typeof planVideoPresentationSpec;
    audioGenerator?: typeof generateVideoPresentationNarrationAudio;
    onStage?: (
      event: VideoPresentationProjectStageEvent,
      metadata?: Record<string, unknown>,
    ) => void | Promise<void>;
    startedAt?: number;
    signal?: AbortSignal;
  } = {},
): Promise<VideoPresentationRenderJobResult> {
  const startedAt = deps.startedAt ?? Date.now();
  deps.signal?.throwIfAborted();
  const artifact = await findArtifactRecord({
    teamId: payload.teamId,
    workspaceId: payload.workspaceId,
    artifactId: payload.artifactId,
  });
  const currentPayload =
    artifact?.payloadJson && typeof artifact.payloadJson === "object"
      ? (artifact.payloadJson as Record<string, unknown>)
      : buildRunningPayload(payload);

  try {
    deps.signal?.throwIfAborted();
    logVideoProjectStage(payload, "planning_started", {
      elapsedMs: elapsedMs(startedAt),
      narrationEnabled: payload.narrationEnabled,
      sourceContentChars: payload.sourceContent.length,
    });
    await markVideoArtifactRunningOrAbort({
      artifactId: payload.artifactId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      expectedStatuses: ["pending", "running"],
      payload: {
        ...currentPayload,
        generation: { status: "running", stage: "planning" },
      },
    });
    deps.signal?.throwIfAborted();
    await deps.onStage?.(
      { stage: "planning_started", status: "running" },
      {
        elapsedMs: elapsedMs(startedAt),
        narrationEnabled: payload.narrationEnabled,
        sourceContentChars: payload.sourceContent.length,
      },
    );

    const billing = deps.billing ?? billingService;
    const planner = deps.planner ?? planVideoPresentationSpec;
    const audioGenerator =
      deps.audioGenerator ?? generateVideoPresentationNarrationAudio;

    const plannedSpec = await planner({
      artifactId: payload.artifactId,
      billing,
      narrationEnabled: payload.narrationEnabled,
      parentSpanId: payload.parentSpanId,
      sourceContent: payload.sourceContent,
      teamId: payload.teamId,
      threadId: payload.threadId,
      title: payload.title,
      traceId: payload.traceId,
      userId: payload.userId,
      userMessageId: payload.userMessageId,
      userPrompt: payload.userPrompt,
      workspaceId: payload.workspaceId,
      signal: deps.signal,
    });
    deps.signal?.throwIfAborted();

    logVideoProjectStage(payload, "planning_completed", {
      elapsedMs: elapsedMs(startedAt),
      fps: plannedSpec.fps,
      height: plannedSpec.height,
      sceneCount: plannedSpec.scenes.length,
      slideCount: plannedSpec.slides.length,
      width: plannedSpec.width,
    });
    await deps.onStage?.(
      { stage: "planning_completed", status: "running" },
      {
        elapsedMs: elapsedMs(startedAt),
        fps: plannedSpec.fps,
        height: plannedSpec.height,
        sceneCount: plannedSpec.scenes.length,
        slideCount: plannedSpec.slides.length,
        width: plannedSpec.width,
      },
    );

    await markVideoArtifactRunningOrAbort({
      artifactId: payload.artifactId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      expectedStatuses: ["pending", "running"],
      payload: {
        ...currentPayload,
        generation: { status: "running", stage: "generating_audio" },
        plan: {
          slideCount: plannedSpec.slides.length,
          sceneCount: plannedSpec.scenes.length,
        },
      },
    });
    deps.signal?.throwIfAborted();
    await deps.onStage?.(
      { stage: "audio_generation_started", status: "running" },
      {
        elapsedMs: elapsedMs(startedAt),
        sceneCount: plannedSpec.scenes.length,
        slideCount: plannedSpec.slides.length,
      },
    );

    logVideoProjectStage(payload, "audio_generation_started", {
      elapsedMs: elapsedMs(startedAt),
      narrationEnabled: payload.narrationEnabled,
      slideCount: plannedSpec.slides.length,
    });

    let completedAudioSlideCount = 0;
    const audioTracks = await audioGenerator({
      artifactId: payload.artifactId,
      billing,
      parentSpanId: payload.parentSpanId,
      spec: plannedSpec,
      teamId: payload.teamId,
      toolCallId: payload.toolCallId,
      traceId: payload.traceId,
      threadId: payload.threadId,
      userId: payload.userId,
      userMessageId: payload.userMessageId,
      workspaceId: payload.workspaceId,
      signal: deps.signal,
      onSlideStage: async (event) => {
        deps.signal?.throwIfAborted();
        if (event.stage === "audio_slide_completed") {
          completedAudioSlideCount += 1;
        }
        await markVideoArtifactRunningOrAbort({
          artifactId: payload.artifactId,
          teamId: payload.teamId,
          workspaceId: payload.workspaceId,
          expectedStatuses: ["pending", "running"],
          payload: {
            ...currentPayload,
            generation: {
              status: "running",
              stage: "generating_audio",
              audio: {
                completedCount: completedAudioSlideCount,
                currentSlideNumber: event.slideNumber,
                totalCount: plannedSpec.slides.length,
              },
            },
            plan: {
              slideCount: plannedSpec.slides.length,
              sceneCount: plannedSpec.scenes.length,
            },
          },
        });
        deps.signal?.throwIfAborted();
        logVideoProjectStage(payload, event.stage, {
          durationSeconds: event.durationSeconds,
          elapsedMs: elapsedMs(startedAt),
          mimeType: event.mimeType,
          narrationChars: event.narrationChars,
          sizeBytes: event.sizeBytes,
          slideNumber: event.slideNumber,
        });
        await deps.onStage?.(
          { stage: event.stage, status: "running" },
          {
            durationSeconds: event.durationSeconds,
            elapsedMs: elapsedMs(startedAt),
            mimeType: event.mimeType,
            narrationChars: event.narrationChars,
            sizeBytes: event.sizeBytes,
            slideNumber: event.slideNumber,
          },
        );
      },
    });
    deps.signal?.throwIfAborted();

    logVideoProjectStage(payload, "audio_generation_completed", {
      elapsedMs: elapsedMs(startedAt),
      audioTrackCount: audioTracks.length,
    });
    await deps.onStage?.(
      { stage: "audio_generation_completed", status: "running" },
      {
        audioTrackCount: audioTracks.length,
        elapsedMs: elapsedMs(startedAt),
      },
    );

    const renderSpec: RenderableVideoPresentationSpec = {
      ...plannedSpec,
      audioTracks,
      narrationEnabled: payload.narrationEnabled,
    };
    const durationSeconds = getVideoDurationSeconds(renderSpec);

    logVideoProjectStage(payload, "project_finalizing", {
      durationSeconds,
      elapsedMs: elapsedMs(startedAt),
      fps: renderSpec.fps,
      sceneCount: renderSpec.scenes.length,
      slideCount: renderSpec.slides.length,
    });

    await markVideoArtifactRunningOrAbort({
      artifactId: payload.artifactId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      expectedStatuses: ["pending", "running"],
      payload: {
        ...currentPayload,
        generation: { status: "running", stage: "finalizing_project" },
        plan: {
          slideCount: renderSpec.slides.length,
          sceneCount: renderSpec.scenes.length,
        },
        video: {
          durationSeconds,
          fps: renderSpec.fps,
          narrationEnabled: renderSpec.narrationEnabled,
        },
      },
    });
    deps.signal?.throwIfAborted();
    await deps.onStage?.(
      { stage: "project_finalizing", status: "running" },
      {
        durationSeconds,
        elapsedMs: elapsedMs(startedAt),
        fps: renderSpec.fps,
        sceneCount: renderSpec.scenes.length,
        slideCount: renderSpec.slides.length,
      },
    );

    const fileName = buildVideoPresentationProjectFileName(payload.title);
    const manifestPayload = buildProjectManifest({
      spec: renderSpec,
      fileName,
      title: payload.title,
    });
    const finalPayload = {
      ...manifestPayload,
      prompt:
        payload.userPrompt ??
        compactVideoPresentationText(
          stripVideoPresentationMarkdown(payload.sourceContent),
        ),
      ...(payload.jobId ? { jobId: payload.jobId } : {}),
      ...(payload.requestKey ? { requestKey: payload.requestKey } : {}),
      mimeType: "application/vnd.sourceweft.video-presentation+json",
      fileName,
      generation: {
        status: "ready",
        stage: "project_ready",
      },
    };

    const { versionId } = await markVideoPresentationArtifactReady({
      artifactId: payload.artifactId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      userId: payload.userId,
      payload: finalPayload,
      storageBucket: artifact?.storageBucket ?? null,
      storageKey: artifact?.storageKey ?? null,
    });

    logVideoProjectStage(payload, "project_ready", {
      durationSeconds,
      elapsedMs: elapsedMs(startedAt),
      fileName,
      versionId,
    });
    await deps.onStage?.(
      { stage: "project_ready", status: "ready" },
      {
        durationSeconds,
        elapsedMs: elapsedMs(startedAt),
        fileName,
        versionId,
      },
    );

    return {
      status: "ready",
      artifactId: payload.artifactId,
      versionId,
      fileName,
      durationSeconds,
    };
  } catch (error) {
    if (deps.signal?.aborted) {
      throw error;
    }
    const message = errorMessage(error);
    const errorCode = resolveVideoRenderErrorCode(error);
    logVideoProjectStage(payload, "project_failed", {
      elapsedMs: elapsedMs(startedAt),
      errorCode,
      errorMessage: message,
    });
    await markArtifactFailed({
      artifactId: payload.artifactId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      expectedStatuses: ["pending", "running"],
      errorCode,
      errorMessage: message,
      payload: buildFailedPayload({
        currentPayload,
        errorCode,
        errorMessage: message,
      }),
    });
    await deps.onStage?.(
      { stage: "project_failed", status: "failed" },
      {
        elapsedMs: elapsedMs(startedAt),
        errorCode,
        errorMessage: message,
      },
    );
    return {
      status: "failed",
      artifactId: payload.artifactId,
      errorCode,
      errorMessage: message,
    };
  }
}

export const testExports = {
  buildProjectManifest,
  buildFailedPayload,
  buildRunningPayload,
  createTimeoutError,
};
