import { buildProviderAuthHeaders } from "../auth-headers";
import { createHttpGatewayError } from "../errors";
import type { AsrTransport } from "./types";
import {
  OPENAI_COMPATIBLE_ASR_AUDIO_FORMATS,
  appendFormValue,
  asrAudioInputToBlob,
  normalizeAsrSegments,
  normalizeAsrWords,
  normalizeResponseFormat,
  normalizeTimestampGranularities,
  resolveAsrAudioFormat,
} from "./asr-utils";
import { normalizeModelCallObservation } from "../observation/normalize";

export class OpenAICompatibleAsrTransport implements AsrTransport {
  readonly kind: AsrTransport["kind"] = "openai-compatible";

  readonly supportedAudioFormats = OPENAI_COMPATIBLE_ASR_AUDIO_FORMATS;

  protected resolveBaseUrl(
    target: Parameters<AsrTransport["execute"]>[0]["target"],
  ) {
    return target.baseUrl.replace(/\/+$/, "");
  }

  async execute(input: Parameters<AsrTransport["execute"]>[0]) {
    resolveAsrAudioFormat({
      fileName: input.payload.fileName,
      mimeType: input.payload.mimeType,
      supportedAudioFormats: this.supportedAudioFormats,
      provider: input.target.provider,
      model: input.target.providerModel,
    });

    const form = new FormData();
    form.append(
      "file",
      asrAudioInputToBlob(input.payload),
      input.payload.fileName,
    );
    form.append("model", input.target.providerModel);
    form.append(
      "response_format",
      normalizeResponseFormat(input.payload.responseFormat),
    );
    for (const granularity of normalizeTimestampGranularities(
      input.payload.timestampGranularities,
    )) {
      form.append("timestamp_granularities[]", granularity);
    }
    appendFormValue(form, "language", input.payload.language);
    appendFormValue(form, "prompt", input.payload.prompt);
    appendFormValue(form, "temperature", input.payload.temperature);
    for (const [key, value] of Object.entries(input.payload.extraBody ?? {})) {
      appendFormValue(form, key, value);
    }

    const response = await input.fetch(
      `${this.resolveBaseUrl(input.target)}/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          ...input.target.defaultHeaders,
          ...buildProviderAuthHeaders(input.target),
        },
        body: form,
        signal: input.options?.signal,
      },
    );

    if (!response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      throw createHttpGatewayError({
        statusCode: response.status,
        body,
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const observation = normalizeModelCallObservation({
      modelAlias: input.target.routeDecision.alias,
      context: {
        target: input.target,
        modality: "asr",
        rawResponse: raw,
        responseHeaders: response.headers,
      },
    });
    return {
      model:
        typeof raw.model === "string" ? raw.model : input.target.providerModel,
      text: typeof raw.text === "string" ? raw.text : "",
      language: typeof raw.language === "string" ? raw.language : undefined,
      duration: typeof raw.duration === "number" ? raw.duration : undefined,
      inputLengthMs:
        typeof raw.input_length_ms === "number"
          ? raw.input_length_ms
          : undefined,
      segments: normalizeAsrSegments(raw.segments),
      words: normalizeAsrWords(raw.words),
      usage: observation.usage,
      observation,
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      routeDecision: input.target.routeDecision,
      traceId: input.options?.traceId,
      raw,
    };
  }
}
