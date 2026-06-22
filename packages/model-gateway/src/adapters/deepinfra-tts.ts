import { buildProviderAuthHeaders } from "../auth-headers";
import type { TtsTransport } from "./types";
import {
  buildTtsSpeechResult,
  compactTtsBody,
  normalizeTtsResponseFormat,
  resolveTtsMimeType,
  throwIfTtsHttpError,
} from "./tts-utils";

export class DeepInfraTtsTransport implements TtsTransport {
  readonly kind = "deepinfra" as const;

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
      traceId: input.options?.traceId,
    });
  }
}
