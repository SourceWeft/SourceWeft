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
 * Plain OpenAI `/v1/audio/speech` transport for openai-compatible gateways
 * (e.g. OrcaRouter). Unlike {@link OpenRouterTtsTransport} it does not wrap
 * `instructions` in OpenRouter's `provider.options.openai` envelope — it passes
 * the OpenAI-native `instructions` field straight through.
 */
export class OpenAICompatibleTtsTransport implements TtsTransport {
  readonly kind = "openai-compatible" as const;

  private buildProviderBody(
    input: Parameters<TtsTransport["execute"]>[0],
  ): Record<string, unknown> {
    return compactTtsBody({
      model: input.target.providerModel,
      input: input.payload.input,
      voice: input.payload.voice ?? "alloy",
      response_format: normalizeTtsResponseFormat(input.payload.responseFormat),
      speed: input.payload.speed,
      instructions: input.payload.instructions,
      ...(input.payload.extraBody ?? {}),
    });
  }

  async execute(input: Parameters<TtsTransport["execute"]>[0]) {
    const responseFormat = normalizeTtsResponseFormat(
      input.payload.responseFormat,
    );
    const response = await input.fetch(
      `${input.target.baseUrl.replace(/\/+$/, "")}/audio/speech`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...input.target.defaultHeaders,
          ...buildProviderAuthHeaders(input.target),
        },
        body: JSON.stringify(this.buildProviderBody(input)),
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
