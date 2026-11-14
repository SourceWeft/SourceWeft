import { buildProviderAuthHeaders } from "../auth-headers";
import { createHttpGatewayError, ModelGatewayError } from "../errors";
import { normalizeModelCallObservation } from "../observation/normalize";
import type { AsrLimits } from "../asr/types";
import { asrAudioInputToBlob } from "./asr-utils";
import type { AsrTransport } from "./types";

/**
 * DeepSeek first-party speech recognition (`POST /v1/tools/asr`).
 *
 * One request takes at most 120 s and 8 MiB of 16-bit PCM WAV (or Ogg Opus)
 * and returns plain text, with no timestamps. The limits below make the
 * gateway decode every input to PCM WAV and cut it into ~100 s chunks, so the
 * transport itself only ever sees a chunk that fits.
 */
const LIMITS: AsrLimits = {
  // Always normalized: a .wav may be float or 24-bit, which DeepSeek rejects.
  acceptedFormats: [],
  maxBytes: 8 * 1024 * 1024,
  maxDurationSec: 120,
  timestamps: "none",
  chunkSec: 100,
  // The account allows 50 in flight; one transcription takes a small share.
  maxConcurrent: 8,
};

function endpointUrl(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/tools/asr` : `${base}/v1/tools/asr`;
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const text = (await response.text()).trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { message: text };
  } catch {
    return { message: text.slice(0, 300) };
  }
}

export class DeepSeekAsrTransport implements AsrTransport {
  readonly kind = "deepseek" as const;

  limits() {
    return LIMITS;
  }

  async execute(input: Parameters<AsrTransport["execute"]>[0]) {
    const { payload, target } = input;
    const reject = (what: string): never => {
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: `DeepSeek ASR ${what}`,
        retryable: false,
        provider: target.provider,
      });
    };
    if (!target.apiKey) reject("requires an API key");
    if (payload.language !== undefined) {
      reject("detects the language itself and does not accept language");
    }
    if (payload.prompt !== undefined) reject("does not support prompt");
    if (payload.temperature !== undefined) {
      reject("does not support temperature");
    }

    const form = new FormData();
    form.append("file", asrAudioInputToBlob(payload), payload.fileName);

    const response = await input.fetch(endpointUrl(target.baseUrl), {
      method: "POST",
      headers: {
        ...Object.fromEntries(
          Object.entries(target.defaultHeaders ?? {}).filter(
            ([name]) => name.toLowerCase() !== "content-type",
          ),
        ),
        ...buildProviderAuthHeaders(target),
      },
      body: form,
      signal: input.options?.signal,
    });

    const raw = await readBody(response);
    if (!response.ok) {
      throw createHttpGatewayError({
        statusCode: response.status,
        body: raw,
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
    }
    if (raw.error !== undefined || typeof raw.text !== "string") {
      const error = raw.error as { message?: unknown } | string | undefined;
      const message =
        typeof error === "string"
          ? error
          : typeof error?.message === "string"
            ? error.message
            : "returned no transcript text";
      throw new ModelGatewayError({
        code: "UPSTREAM",
        message: `DeepSeek ASR failed: ${message}`.slice(0, 300),
        retryable: false,
        provider: target.provider,
      });
    }

    const durationMs =
      typeof raw.duration_ms === "number" ? raw.duration_ms : undefined;
    const observation = normalizeModelCallObservation({
      modelAlias: target.routeDecision.alias,
      context: {
        target,
        modality: "asr",
        rawResponse: raw,
        responseHeaders: response.headers,
      },
    });
    return {
      model: target.providerModel,
      text: raw.text,
      duration: durationMs !== undefined ? durationMs / 1000 : undefined,
      inputLengthMs: durationMs,
      usage: observation.usage,
      observation,
      provider: target.provider,
      providerModel: target.providerModel,
      routeDecision: target.routeDecision,
      traceId: input.options?.traceId,
      raw,
    };
  }
}
