import type {
  AsrTranscribeResult,
  GatewayRequestMetadata,
} from "@sourceweft/model-gateway";
import {
  buildGatewayRequestMetadata,
  recordGatewayOperationEvent,
} from "../../content/model-gateway-audit";
import { meterBillableModelUsage } from "../../content/model-billing";
import { toContentError } from "../../content/model-gateway-error";
import {
  ensureModelConfigAvailable,
  getModelGatewayClient,
  requireDefaultModelGatewayProfile,
} from "../../../shared/model-gateway/index";
import { BaseSourceParser } from "@sourceweft/builtin-document-parsers";
import { buildParsedDocument } from "./providers/utils";
import {
  toBackendParsedDocument,
  type ParsedDocument,
  type ParseInput,
} from "./types";

function requireDefaultAsrProfile() {
  return requireDefaultModelGatewayProfile("asr").catch(() => {
    throw new Error("Default ASR model gateway profile is not configured");
  });
}

const ASR_PAGE_DURATION_MS = 10 * 60 * 1000;

function isPositiveFiniteNumber(
  value: number | null | undefined,
): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function estimateAsrPageCount(input: {
  duration?: number | null;
  inputLengthMs?: number | null;
}) {
  const durationMs = isPositiveFiniteNumber(input.inputLengthMs)
    ? input.inputLengthMs
    : isPositiveFiniteNumber(input.duration)
      ? input.duration * 1000
      : 0;

  return Math.max(1, Math.ceil(durationMs / ASR_PAGE_DURATION_MS));
}

function omitNullishMetadata(
  value: Record<string, unknown>,
): GatewayRequestMetadata {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== null && item !== undefined,
    ),
  ) as GatewayRequestMetadata;
}

function buildAsrRequestMetadata(input: {
  parseInput: ParseInput;
  modelAlias: string;
  profileAlias: string;
}): GatewayRequestMetadata {
  if (!input.parseInput.teamId || !input.parseInput.workspaceId) {
    return {
      feature: "ingestion",
      operation: "asr.transcribe",
      modelKind: "asr",
      modelAlias: input.modelAlias,
      profileAlias: input.profileAlias,
    };
  }

  return omitNullishMetadata(
    buildGatewayRequestMetadata({
      teamId: input.parseInput.teamId,
      workspaceId: input.parseInput.workspaceId,
      userId: input.parseInput.userId ?? undefined,
      feature: "ingestion",
      operation: "asr.transcribe",
      modelKind: "asr",
      modelAlias: input.modelAlias,
      profileAlias: input.profileAlias,
    }),
  );
}

function formatTimestamp(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatAsrTranscriptMarkdown(input: {
  fileName: string;
  result: Pick<AsrTranscribeResult, "text" | "segments">;
}) {
  const title = `# Transcript: ${input.fileName}`;
  const segments = input.result.segments ?? [];
  if (segments.length === 0) {
    return [title, input.result.text.trim()].filter(Boolean).join("\n\n");
  }

  const lines = segments
    .map((segment) => {
      const text = segment.text.trim();
      if (!text) {
        return null;
      }
      return `[${formatTimestamp(segment.start)} - ${formatTimestamp(segment.end)}] ${text}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return [title, input.result.text.trim()].filter(Boolean).join("\n\n");
  }

  return [title, ...lines].join("\n\n");
}

export class AudioSourceParser extends BaseSourceParser {
  readonly id = "audio";
  readonly name = "Audio ASR Parser";
  readonly supportedMimeTypes = [
    "audio/flac",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "video/mp4",
    "video/webm",
  ] as const;

  async parse(input: ParseInput): Promise<ParsedDocument> {
    await ensureModelConfigAvailable();
    const profile = await requireDefaultAsrProfile();
    const gateway = await getModelGatewayClient(profile.gatewayConfigId);
    const startedAt = Date.now();

    const result = await gateway.asr
      .transcribe(
        {
          model: profile.modelAlias,
          audio: new Uint8Array(input.content),
          fileName: input.fileName,
          mimeType: input.mimeType,
          responseFormat: "verbose_json",
          timestampGranularities: ["segment"],
          metadata: buildAsrRequestMetadata({
            parseInput: input,
            modelAlias: profile.modelAlias,
            profileAlias: profile.profileAlias,
          }),
        },
        {
          idempotencyKey:
            input.idempotencyKey ||
            `source-asr:${input.sourceId ?? input.fileName}:${input.fileSize}`,
          traceId: input.sourceId,
          metadata: buildAsrRequestMetadata({
            parseInput: input,
            modelAlias: profile.modelAlias,
            profileAlias: profile.profileAlias,
          }),
        },
      )
      .catch(async (error: unknown) => {
        const contentError = toContentError(error);
        if (input.teamId && input.workspaceId) {
          await recordGatewayOperationEvent({
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            feature: "ingestion",
            operation: "asr.transcribe",
            modelKind: "asr",
            modelAlias: profile.modelAlias,
            traceId: input.sourceId,
            success: false,
            errorCode: contentError.code,
            errorMessage: contentError.message,
            latencyMs: Date.now() - startedAt,
            attributes: {
              sourceId: input.sourceId,
              fileName: input.fileName,
              mimeType: input.mimeType,
              fileSize: input.fileSize,
            },
          });
        }
        throw contentError;
      });

    if (input.teamId && input.workspaceId) {
      await recordGatewayOperationEvent({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        feature: "ingestion",
        operation: "asr.transcribe",
        modelKind: "asr",
        modelAlias: profile.modelAlias,
        provider: result.provider,
        routeDecision: result.routeDecision as unknown as Record<
          string,
          unknown
        > | null,
        usage: result.usage,
        traceId: input.sourceId,
        success: true,
        latencyMs: Date.now() - startedAt,
        attributes: {
          sourceId: input.sourceId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          segmentCount: result.segments?.length ?? 0,
          wordTimestampCount: result.words?.length ?? 0,
        },
      });
    }
    if (input.teamId && input.workspaceId && input.userId && input.billing) {
      await meterBillableModelUsage({
        billing: input.billing,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.userId,
        feature: "ingestion.asr",
        operation: "asr.transcribe",
        modelKind: "asr",
        gatewayConfigId: profile.gatewayConfigId,
        profileAlias: profile.profileAlias,
        modelAlias: profile.modelAlias,
        referenceId: input.sourceId
          ? `source:${input.sourceId}:asr`
          : `source-file:${input.fileName}:asr`,
        idempotencyKey:
          input.idempotencyKey ||
          `source-asr:${input.sourceId ?? input.fileName}:${input.fileSize}:credits`,
        usage: result.usage,
        metadata: {
          traceId: input.sourceId,
          sourceId: input.sourceId,
          sourceRevisionId: input.sourceRevisionId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          provider: result.provider,
          providerModel: result.providerModel,
          routeDecision: result.routeDecision,
          duration: result.duration,
          inputLengthMs: result.inputLengthMs,
          segmentCount: result.segments?.length ?? 0,
          wordTimestampCount: result.words?.length ?? 0,
        },
      });
    }

    const content = formatAsrTranscriptMarkdown({
      fileName: input.fileName,
      result,
    });
    if (!content.trim()) {
      throw new Error("ASR transcription returned empty text");
    }
    const pageCount = estimateAsrPageCount(result);

    return toBackendParsedDocument(
      await buildParsedDocument({
        parseInput: input,
        title: input.fileName,
        content,
        metadata: {
          pageCount,
          sourceFileKind: "audio",
          asrModelAlias: profile.modelAlias,
          asrProfileAlias: profile.profileAlias,
          asrProvider: result.provider,
          asrProviderModel: result.providerModel,
          language: result.language,
          duration: result.duration,
          inputLengthMs: result.inputLengthMs,
          segmentCount: result.segments?.length ?? 0,
          wordTimestampCount: result.words?.length ?? 0,
        },
      }),
    );
  }
}

export const audioSourceParser = new AudioSourceParser();
