import type { Job } from "bullmq";
import type {
  VideoPresentationRenderJobPayload,
  VideoPresentationRenderJobResult,
} from "../../modules/content/queue";
import { processVideoPresentationRenderJob as processVideoPresentationRenderJobPayload } from "../../modules/content/video-presentation/render-job";
import { logger } from "../../shared/logger";

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

function safeProgressMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) {
    return {};
  }
  const allowedKeys = [
    "audioTrackCount",
    "durationSeconds",
    "elapsedMs",
    "errorCode",
    "errorMessage",
    "fileName",
    "fps",
    "height",
    "mimeType",
    "narrationChars",
    "narrationEnabled",
    "sceneCount",
    "sizeBytes",
    "slideCount",
    "slideNumber",
    "sourceContentChars",
    "versionId",
    "width",
  ];
  const safe: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const value = metadata[key];
    if (value !== undefined) {
      safe[key] = value;
    }
  }
  return safe;
}

function buildLogContext(input: {
  jobId: string;
  payload: VideoPresentationRenderJobPayload;
  stage: string;
  startedAt: number;
  metadata?: Record<string, unknown>;
}) {
  return {
    artifactId: input.payload.artifactId,
    elapsedMs: elapsedMs(input.startedAt),
    jobId: input.jobId,
    requestKey: input.payload.requestKey,
    stage: input.stage,
    teamId: input.payload.teamId,
    threadId: input.payload.threadId,
    toolCallId: input.payload.toolCallId,
    userId: input.payload.userId,
    userMessageId: input.payload.userMessageId,
    workspaceId: input.payload.workspaceId,
    ...safeProgressMetadata(input.metadata),
  };
}

export async function processVideoPresentationRenderJob(
  job: Job<Record<string, unknown>>,
): Promise<VideoPresentationRenderJobResult> {
  const startedAt = Date.now();
  const jobId = String(job.id ?? job.name);
  const payload = {
    ...(job.data as VideoPresentationRenderJobPayload),
    jobId,
  };
  logger.info(
    "Video presentation render job event",
    buildLogContext({
      jobId,
      payload,
      stage: "job_started",
      startedAt,
      metadata: {
        narrationEnabled: payload.narrationEnabled,
        sourceContentChars: payload.sourceContent.length,
      },
    }),
  );
  await job.updateProgress({
    elapsedMs: 0,
    stage: "job_started",
    status: "running",
  });

  const result = await processVideoPresentationRenderJobPayload(payload, {
    onStage: async (event, metadata) => {
      const safeMetadata = safeProgressMetadata(metadata);
      const progress = {
        ...safeMetadata,
        elapsedMs: elapsedMs(startedAt),
        stage: event.stage,
        status: event.status,
      };
      await job.updateProgress(progress);
      logger.info(
        "Video presentation render job event",
        buildLogContext({
          jobId,
          payload,
          stage: event.stage,
          startedAt,
          metadata: safeMetadata,
        }),
      );
    },
  });
  if (result.status === "failed") {
    logger.error(
      "Video presentation render job event",
      buildLogContext({
        jobId,
        payload,
        stage: "project_failed",
        startedAt,
        metadata: {
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        },
      }),
    );
  }
  if (result.status === "failed") {
    return result;
  }
  logger.info(
    "Video presentation render job event",
    buildLogContext({
      jobId,
      payload,
      stage: "project_ready",
      startedAt,
      metadata: {
        durationSeconds: result.durationSeconds,
        fileName: result.fileName,
        versionId: result.versionId,
      },
    }),
  );
  return result;
}
