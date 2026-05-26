import { createHttpGatewayError, ModelGatewayError } from "../errors";
import { normalizeUsage } from "../normalize/usage";
import type { ResolvedRequestTarget, TtsSpeechResult } from "../types";

const MIME_TYPE_BY_RESPONSE_FORMAT: Record<string, string> = {
  aac: "audio/aac",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  opus: "audio/opus",
  pcm: "audio/pcm",
  wav: "audio/wav",
};

export function compactTtsBody(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
}

export function normalizeTtsResponseFormat(value: string | undefined) {
  return value?.trim() || "mp3";
}

export function resolveTtsMimeType(input: {
  contentType?: string | null;
  responseFormat?: string;
}) {
  const normalizedContentType = input.contentType?.split(";")[0]?.trim();
  if (normalizedContentType) {
    return normalizedContentType;
  }
  return MIME_TYPE_BY_RESPONSE_FORMAT[
    normalizeTtsResponseFormat(input.responseFormat).toLowerCase()
  ];
}

async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text };
  }
}

export async function throwIfTtsHttpError(response: Response) {
  if (response.ok) {
    return;
  }
  throw createHttpGatewayError({
    statusCode: response.status,
    body: await parseErrorBody(response),
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("cf-ray") ??
      undefined,
  });
}

export function buildTtsSpeechResult(input: {
  audio: ArrayBuffer;
  mimeType?: string;
  raw?: Record<string, unknown>;
  target: ResolvedRequestTarget;
  traceId?: string;
}): TtsSpeechResult {
  if (input.audio.byteLength === 0) {
    throw new ModelGatewayError({
      code: "UPSTREAM",
      message: "TTS provider returned empty audio",
      retryable: true,
    });
  }

  const raw = input.raw ?? {};
  return {
    model:
      typeof raw.model === "string" ? raw.model : input.target.providerModel,
    audio: input.audio,
    mimeType: input.mimeType,
    usage: normalizeUsage(raw.usage ?? raw),
    provider: input.target.provider,
    providerModel: input.target.providerModel,
    routeDecision: input.target.routeDecision,
    traceId: input.traceId,
    raw,
  };
}
