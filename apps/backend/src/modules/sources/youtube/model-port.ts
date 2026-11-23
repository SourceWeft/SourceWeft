import { isBillingError } from "@sourceweft/contracts/billing-runtime";
import type { VideoModelPort } from "@sourceweft/builtin-document-parsers/youtube";
import type { ContentBillingPort } from "../../content/billing-port";
import { ContentError } from "../../content/errors";
import { recordGatewayOperationEvent } from "../../content/model-gateway-audit";
import { toContentError } from "../../content/model-gateway-error";
import {
  BillingAdmissionError,
  buildStandaloneGatewayConfig,
  withBilledModelGateway,
} from "../../../shared/model-gateway/index";

/**
 * The service YouTube transcription runs on. It belongs to the YouTube
 * feature, not to the model gateway configuration: it is never offered as a
 * model, never enters GLOBAL routing and does not follow OPENROUTER_ENABLED.
 * Moving transcription to another API changes this declaration (and, for an
 * API that is not a chat model, the package's transcript provider), never the
 * model configuration.
 */
export const YOUTUBE_TRANSCRIPT_SERVICE = {
  id: "youtube-transcript",
  providerKind: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "google/gemini-2.5-flash",
  /** The deployment's OpenRouter credential; its presence is the only switch. */
  apiKeyEnv: "OPENROUTER_API_KEY",
} as const;

const AUDIT_FEATURE = "ingestion";
const BILLING_FEATURE = "ingestion.youtube";
const OPERATION = "source.youtube_transcribe";

/**
 * One transcription can run for many minutes on a long video, far past the
 * gateway's default per-attempt timeout. The call is bounded on its own.
 */
export const YOUTUBE_TRANSCRIPT_TIMEOUT_MS = 900_000;
/**
 * No SDK retries: a retry re-sends the whole video, doubling the wait and
 * the provider cost of a call that already ran to its timeout.
 */
export const YOUTUBE_TRANSCRIPT_MAX_RETRIES = 0;

function readYouTubeTranscriptApiKey(): string {
  const apiKey = process.env[YOUTUBE_TRANSCRIPT_SERVICE.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new ContentError(
      503,
      "YOUTUBE_TRANSCRIPTION_NOT_CONFIGURED",
      "YouTube transcription is not configured for this deployment.",
    );
  }
  return apiKey;
}

/**
 * Fails fast, before a source is created, when the deployment has no
 * credential for the transcription service: the source could never be
 * transcribed.
 */
export async function assertYouTubeTranscriptionConfigured(): Promise<void> {
  readYouTubeTranscriptApiKey();
}

/**
 * Text of the model's answer. A provider may return the message as content
 * blocks rather than a string; only the text blocks are the transcript.
 */
function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "string"
          ? block
          : block &&
              typeof block === "object" &&
              (block as { type?: unknown }).type === "text" &&
              typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
      )
      .join("");
  }
  return content === null || content === undefined ? "" : String(content);
}

function isBillingRefusal(error: unknown) {
  return error instanceof BillingAdmissionError || isBillingError(error);
}

// The error must be about the video itself: "url … not found" or "file not
// found" from a gateway or route is not a video that is unavailable.
const VIDEO_SUBJECT_RE = /\b(video|youtube)\b/i;
const UNAVAILABLE_RE =
  /\b(private|unavailable|not available|not found|removed|deleted|does not exist|no longer exists|inaccessible|cannot be accessed)\b/i;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Whether the provider rejected the request because the video itself cannot
 * be read (private, removed, region-locked …) rather than because of the
 * model, the route or a transient fault. Only a client-side (4xx, not 429)
 * provider answer that talks about the video qualifies.
 */
function isVideoUnavailable(error: unknown, contentError: ContentError) {
  const details =
    contentError.details && typeof contentError.details === "object"
      ? (contentError.details as Record<string, unknown>)
      : {};
  const status =
    typeof details.statusCode === "number"
      ? details.statusCode
      : contentError.statusCode;
  if (status < 400 || status >= 500 || status === 429) {
    return false;
  }
  return [contentError.message, errorMessage(error)].some(
    (message) => VIDEO_SUBJECT_RE.test(message) && UNAVAILABLE_RE.test(message),
  );
}

/**
 * The error a failed transcription call surfaces as. A billing refusal keeps
 * its own code (the UI must tell "out of credits" from "this video failed");
 * everything else becomes one of the two YouTube transcript codes, with the
 * mapped gateway error's details kept for diagnosis.
 */
function toYouTubeTranscriptError(
  error: unknown,
  contentError: ContentError,
): unknown {
  if (isBillingRefusal(error)) {
    return error;
  }
  const details = {
    ...(contentError.details && typeof contentError.details === "object"
      ? (contentError.details as Record<string, unknown>)
      : {}),
    modelErrorCode: contentError.code,
  };
  if (isVideoUnavailable(error, contentError)) {
    return new ContentError(
      422,
      "YOUTUBE_VIDEO_UNAVAILABLE",
      "This YouTube video is private, removed or otherwise unavailable.",
      { details },
    );
  }
  return new ContentError(
    502,
    "YOUTUBE_TRANSCRIPT_FAILED",
    `YouTube transcription failed: ${contentError.message}`,
    { details },
  );
}

/**
 * `VideoModelPort` over the billed model gateway: the YouTube transcription
 * service as a standalone provider, billed to the parse job's user under its
 * own ledger key, thinking off, audited like ASR transcription.
 */
export async function createBilledVideoModelPort(input: {
  billing: ContentBillingPort;
  teamId: string;
  workspaceId: string;
  userId: string;
  sourceId: string;
  idempotencyKey: string;
}): Promise<VideoModelPort> {
  // Transcription is charged to a team; it never runs unbilled because a
  // caller forgot part of the context.
  const { billing, teamId, workspaceId, userId, sourceId, idempotencyKey } =
    input;
  if (!teamId || !workspaceId || !userId || !billing) {
    throw new Error(
      "YouTube transcription requires teamId, workspaceId, userId and a billing port",
    );
  }
  if (!sourceId || !idempotencyKey) {
    throw new Error(
      "YouTube transcription requires a sourceId and an idempotency key",
    );
  }

  const service = YOUTUBE_TRANSCRIPT_SERVICE;
  const standaloneConfig = buildStandaloneGatewayConfig({
    id: service.id,
    providerKind: service.providerKind,
    baseUrl: service.baseUrl,
    model: service.model,
    apiKey: readYouTubeTranscriptApiKey(),
    supports: ["chat"],
    timeoutMs: YOUTUBE_TRANSCRIPT_TIMEOUT_MS,
    maxRetries: YOUTUBE_TRANSCRIPT_MAX_RETRIES,
  });

  return {
    async complete(call) {
      const startedAt = Date.now();
      const auditBase = {
        teamId,
        workspaceId,
        userId,
        feature: AUDIT_FEATURE,
        operation: OPERATION,
        modelKind: "vision" as const,
        modelAlias: service.id,
        profileAlias: service.id,
        traceId: sourceId,
      };
      const attributes = { sourceId, videoUrl: call.videoUrl };

      let result;
      try {
        result = await withBilledModelGateway(
          {
            billing,
            standaloneConfig,
            context: {
              teamId,
              workspaceId,
              actorUserId: userId,
              feature: BILLING_FEATURE,
              intent: { mode: "billed" },
              scopeKind: "worker-job",
              scopeId: sourceId,
            },
          },
          (gateway) =>
            gateway.chat.complete(
              {
                model: service.id,
                profileAlias: service.id,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: call.prompt },
                      { type: "video_url", video_url: { url: call.videoUrl } },
                    ],
                  },
                ],
                maxTokens: call.maxOutputTokens,
                thinking: {
                  mode: "off",
                  enabled: false,
                  includeReasoning: false,
                },
              },
              {
                traceId: sourceId,
                operation: OPERATION,
                modelKind: "vision",
                gatewayConfigId: null,
                profileAlias: service.id,
                modelAlias: service.id,
                referenceId: `source:${sourceId}:youtube-transcript`,
                idempotencyKey: `${idempotencyKey}:youtube-transcript`,
                timeoutMs: YOUTUBE_TRANSCRIPT_TIMEOUT_MS,
                maxRetries: YOUTUBE_TRANSCRIPT_MAX_RETRIES,
              },
            ),
        );
      } catch (error) {
        const contentError = toContentError(error);
        await recordGatewayOperationEvent({
          ...auditBase,
          success: false,
          errorCode: contentError.code,
          errorMessage: contentError.message,
          latencyMs: Date.now() - startedAt,
          attributes,
        });
        throw toYouTubeTranscriptError(error, contentError);
      }

      await recordGatewayOperationEvent({
        ...auditBase,
        provider: result.provider,
        routeDecision: result.routeDecision as unknown as Record<
          string,
          unknown
        > | null,
        usage: result.usage,
        success: true,
        latencyMs: Date.now() - startedAt,
        attributes: { ...attributes, finishReason: result.finishReason },
      });

      return {
        text: messageText(result.raw.content),
        finishReason: result.finishReason,
        model: result.providerModel,
      };
    },
  };
}
