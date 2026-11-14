import { buildProviderAuthHeaders } from "../auth-headers";
import { ModelGatewayError } from "../errors";
import type { TtsTransport } from "./types";
import { buildTtsSpeechResult, throwIfTtsHttpError } from "./tts-utils";

/**
 * DeepSeek first-party speech synthesis (`POST /v1/tools/tts`).
 *
 * The endpoint has a narrower contract than the OpenAI-style one: only `wav`
 * and `pcm` output, two voices, no speed and no instructions, and at most
 * 10,000 billed units per request (a Chinese character is two units). Anything
 * outside that is rejected here instead of being dropped, so a caller never
 * gets audio that silently differs from what it asked for. Splitting long
 * text is the caller's job.
 */
const DEFAULT_VOICE = "stella";
const DEFAULT_FORMAT = "wav";
const SUPPORTED_FORMATS = new Set(["wav", "pcm"]);
const MAX_BILLED_UNITS = 10_000;
const HAN = /\p{Script=Han}/u;

function reject(message: string, provider: string): never {
  throw new ModelGatewayError({
    code: "BAD_REQUEST",
    message: `DeepSeek TTS ${message}`,
    retryable: false,
    provider,
  });
}

export function countDeepSeekTtsUnits(text: string) {
  let units = 0;
  for (const char of text) {
    units += HAN.test(char) ? 2 : 1;
  }
  return units;
}

function endpointUrl(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/tools/tts` : `${base}/v1/tools/tts`;
}

export class DeepSeekTtsTransport implements TtsTransport {
  readonly kind = "deepseek" as const;

  async execute(input: Parameters<TtsTransport["execute"]>[0]) {
    const { payload, target } = input;
    const provider = target.provider;

    if (!target.apiKey) {
      reject("requires an API key", provider);
    }
    if (payload.speed !== undefined) {
      reject("does not support speed", provider);
    }
    if (payload.instructions !== undefined) {
      reject("does not support instructions", provider);
    }
    const format =
      payload.responseFormat?.trim().toLowerCase() || DEFAULT_FORMAT;
    if (!SUPPORTED_FORMATS.has(format)) {
      reject(`only outputs wav or pcm, not ${format}`, provider);
    }
    const billedUnits = countDeepSeekTtsUnits(payload.input);
    if (billedUnits > MAX_BILLED_UNITS) {
      reject(
        `accepts at most 10,000 billed units per request (a Chinese character counts as 2); this text is ${billedUnits}`,
        provider,
      );
    }

    const response = await input.fetch(endpointUrl(target.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...target.defaultHeaders,
        ...buildProviderAuthHeaders(target),
      },
      body: JSON.stringify({
        text: payload.input,
        voice_id: payload.voice?.trim() || DEFAULT_VOICE,
        format,
        ...payload.extraBody,
      }),
      signal: input.options?.signal,
    });

    await throwIfTtsHttpError(response);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const message =
        typeof body.error === "string"
          ? body.error
          : typeof body.error?.message === "string"
            ? body.error.message
            : typeof body.message === "string"
              ? body.message
              : "returned JSON instead of audio";
      throw new ModelGatewayError({
        code: "UPSTREAM",
        message: `DeepSeek TTS failed: ${message}`.slice(0, 300),
        retryable: false,
        provider,
      });
    }

    return buildTtsSpeechResult({
      audio: await response.arrayBuffer(),
      mimeType:
        contentType.split(";")[0]?.trim() ||
        (format === "pcm" ? "audio/pcm" : "audio/wav"),
      raw: { billedUnits },
      target,
      responseHeaders: response.headers,
      traceId: input.options?.traceId,
    });
  }
}
