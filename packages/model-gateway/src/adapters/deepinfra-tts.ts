import { buildProviderAuthHeaders } from "../auth-headers";
import type { TtsTransport } from "./types";
import {
  buildTtsSpeechResult,
  compactTtsBody,
  normalizeTtsResponseFormat,
  resolveTtsMimeType,
  throwIfTtsHttpError,
} from "./tts-utils";

/**
 * Built-in voices per hosted model, exact and case-sensitive. DeepInfra
 * answers any other voice with HTTP 500 "TTS request failed". Models not
 * listed here take whatever voice the caller gives.
 */
const VOICES_BY_MODEL: Readonly<Record<string, readonly string[]>> = {
  "XiaomiMiMo/MiMo-V2.5-tts": [
    "mimo_default",
    "Mia",
    "Chloe",
    "Milo",
    "Dean",
    "冰糖",
    "茉莉",
    "苏打",
    "白桦",
  ],
};

export class DeepInfraTtsTransport implements TtsTransport {
  readonly kind = "deepinfra" as const;

  voices(target: Parameters<NonNullable<TtsTransport["voices"]>>[0]) {
    return VOICES_BY_MODEL[target.providerModel];
  }

  async execute(input: Parameters<TtsTransport["execute"]>[0]) {
    const responseFormat = normalizeTtsResponseFormat(
      input.payload.responseFormat,
    );
    const response = await input.fetch(
      `${input.target.baseUrl.replace(/\/+$/, "")}/openai/audio/speech`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...input.target.defaultHeaders,
          ...buildProviderAuthHeaders(input.target),
        },
        body: JSON.stringify(
          compactTtsBody({
            model: input.target.providerModel,
            input: input.payload.input,
            voice: input.payload.voice,
            response_format: responseFormat,
            speed: input.payload.speed,
            instructions: input.payload.instructions,
            ...input.payload.extraBody,
          }),
        ),
        signal: input.options?.signal,
      },
    );

    await throwIfTtsHttpError(response);

    return buildTtsSpeechResult({
      audio: await response.arrayBuffer(),
      mimeType: resolveTtsMimeType({
        contentType: response.headers.get("content-type"),
        responseFormat,
      }),
      target: input.target,
      responseHeaders: response.headers,
      traceId: input.options?.traceId,
    });
  }
}
