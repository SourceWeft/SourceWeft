import type { TtsResponseFormat, TtsSpeechInput } from "@sourceweft/model-gateway";
import type { VideoPresentationSpec } from "@sourceweft/contracts/video-presentation";
import { getModelGatewayClient } from "../../../shared/model-gateway/client";
import { requireDefaultModelGatewayProfile } from "../../../shared/model-gateway";
import type { ContentBillingPort } from "../billing-port";
import { meterBillableModelUsage } from "../model-billing";
import {
  buildArtifactStorageKey,
  getContentStorageBucketName,
  uploadArtifactObject,
} from "../storage";
import {
  buildArtifactAssetUrl,
  compactVideoPresentationText,
  estimateNarrationDurationSeconds,
  stripVideoPresentationMarkdown,
  type RenderableVideoPresentationAudioTrack,
} from "./spec";

const TTS_REQUEST_TIMEOUT_MS = 90_000;

function responseFormatToMimeType(format: string | undefined) {
  switch (format) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/opus";
    case "wav":
      return "audio/wav";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}

function extensionForAudio(input: {
  mimeType?: string;
  responseFormat?: string;
}) {
  if (input.responseFormat) {
    return input.responseFormat === "mpeg" ? "mp3" : input.responseFormat;
  }
  const mime = input.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/aac") return "aac";
  if (mime === "audio/flac") return "flac";
  if (mime === "audio/opus" || mime === "audio/ogg") return "opus";
  return "mp3";
}

function buildTtsGatewayMetadata(input: {
  traceId?: string;
  parentSpanId?: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  threadId: string;
  userMessageId: string;
  toolCallId?: string;
  slideNumber: number;
}) {
  return {
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    threadId: input.threadId,
    messageId: input.userMessageId,
    toolCallId: input.toolCallId,
    slideNumber: input.slideNumber,
    observationName: "video_presentation_narration",
    feature: "artifact.video_presentation",
    modelKind: "tts",
  };
}

export async function generateVideoPresentationNarrationAudio(input: {
  artifactId: string;
  billing?: ContentBillingPort;
  onSlideStage?: (event: {
    durationSeconds?: number;
    mimeType?: string;
    narrationChars?: number;
    sizeBytes?: number;
    slideNumber: number;
    stage: "audio_slide_started" | "audio_slide_completed";
  }) => void | Promise<void>;
  parentSpanId?: string;
  responseFormat?: TtsResponseFormat;
  spec: VideoPresentationSpec;
  speed?: number;
  teamId: string;
  toolCallId?: string;
  traceId?: string;
  threadId: string;
  userId: string;
  userMessageId: string;
  voice?: string;
  workspaceId: string;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  if (!input.spec.narrationEnabled) {
    return [];
  }

  const profile = await requireDefaultModelGatewayProfile("tts");
  input.signal?.throwIfAborted();
  const gateway = await getModelGatewayClient(profile.gatewayConfigId);
  input.signal?.throwIfAborted();
  const bucket = getContentStorageBucketName();
  const responseFormat = input.responseFormat ?? "mp3";
  const voice = input.voice ?? "alloy";
  const tracks: RenderableVideoPresentationAudioTrack[] = [];

  for (const slide of input.spec.slides) {
    input.signal?.throwIfAborted();
    const narration = compactVideoPresentationText(
      stripVideoPresentationMarkdown(slide.speakerTranscript.join(" ")),
      3000,
    );
    if (!narration) {
      continue;
    }

    input.signal?.throwIfAborted();
    await input.onSlideStage?.({
      narrationChars: narration.length,
      slideNumber: slide.slideNumber,
      stage: "audio_slide_started",
    });

    const request: TtsSpeechInput = {
      model: profile.modelAlias,
      input: narration,
      voice,
      responseFormat,
      speed: input.speed ?? 1,
      profileAlias: profile.profileAlias,
      metadata: buildTtsGatewayMetadata({
        traceId: input.traceId,
        parentSpanId: input.parentSpanId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        threadId: input.threadId,
        userMessageId: input.userMessageId,
        toolCallId: input.toolCallId,
        slideNumber: slide.slideNumber,
      }),
    };
    const result = await gateway.tts.speech(request, {
      signal: input.signal,
      traceId: input.traceId,
      timeoutMs: TTS_REQUEST_TIMEOUT_MS,
      metadata: {
        parentSpanId: input.parentSpanId,
        toolCallId: input.toolCallId,
      },
    });
    input.signal?.throwIfAborted();
    const ext = extensionForAudio({
      mimeType: result.mimeType,
      responseFormat,
    });
    const fileName = `narration-slide-${String(slide.slideNumber).padStart(2, "0")}.${ext}`;
    const storageKey = buildArtifactStorageKey({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      fileName,
    });
    const body = Buffer.from(result.audio);
    const mimeType = result.mimeType ?? responseFormatToMimeType(responseFormat);
    await uploadArtifactObject({
      key: storageKey,
      body,
      contentType: mimeType,
      signal: input.signal,
    });
    input.signal?.throwIfAborted();

    if (input.billing) {
      input.signal?.throwIfAborted();
      await meterBillableModelUsage({
        billing: input.billing,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.userId,
        feature: "artifact.video_presentation",
        operation: "tts.speech",
        modelKind: "tts",
        gatewayConfigId: profile.gatewayConfigId,
        profileAlias: profile.profileAlias,
        modelAlias: profile.modelAlias,
        referenceId: `artifact:${input.artifactId}:slide:${slide.slideNumber}`,
        idempotencyKey: `artifact-video-presentation:${input.artifactId}:tts:${slide.slideNumber}`,
        usage: result.usage,
        metadata: {
          traceId: input.traceId,
          threadId: input.threadId,
          messageId: input.userMessageId,
          toolCallId: input.toolCallId,
          artifactId: input.artifactId,
          slideNumber: slide.slideNumber,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
        },
      });
    }
    input.signal?.throwIfAborted();

    const durationSeconds = estimateNarrationDurationSeconds(narration);
    tracks.push({
      assetUrl: buildArtifactAssetUrl({
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        fileName,
      }),
      durationSeconds,
      fileName,
      mimeType,
      narration,
      provider: result.provider,
      providerModel: result.providerModel,
      renderSrc: `data:${mimeType};base64,${body.toString("base64")}`,
      sizeBytes: body.byteLength,
      slideNumber: slide.slideNumber,
      storageBucket: bucket,
      storageKey,
    });

    await input.onSlideStage?.({
      durationSeconds,
      mimeType,
      sizeBytes: body.byteLength,
      slideNumber: slide.slideNumber,
      stage: "audio_slide_completed",
    });
  }

  return tracks;
}
