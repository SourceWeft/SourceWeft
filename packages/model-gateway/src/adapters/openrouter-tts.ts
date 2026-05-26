import type { TtsTransport } from "./types";
import {
  buildTtsSpeechResult,
  compactTtsBody,
  normalizeTtsResponseFormat,
  resolveTtsMimeType,
  throwIfTtsHttpError,
} from "./tts-utils";

function mergeOpenRouterOpenAIOptions(
  extraBody: Record<string, unknown> | undefined,
  instructions: string | undefined,
) {
  if (!instructions) {
    return extraBody;
  }

  const provider =
    extraBody?.provider && typeof extraBody.provider === "object" && !Array.isArray(extraBody.provider)
      ? (extraBody.provider as Record<string, unknown>)
      : {};
  const options =
    provider.options && typeof provider.options === "object" && !Array.isArray(provider.options)
      ? (provider.options as Record<string, unknown>)
      : {};
  const openai =
    options.openai && typeof options.openai === "object" && !Array.isArray(options.openai)
      ? (options.openai as Record<string, unknown>)
      : {};

  return {
    ...(extraBody ?? {}),
    provider: {
      ...provider,
      options: {
        ...options,
        openai: {
          ...openai,
          instructions,
        },
      },
    },
  };
}

export class OpenRouterTtsTransport implements TtsTransport {
  readonly kind = "openrouter" as const;

  private buildProviderBody(
    input: Parameters<TtsTransport["execute"]>[0],
  ): Record<string, unknown> {
    return compactTtsBody({
      model: input.target.providerModel,
      input: input.payload.input,
      voice: input.payload.voice ?? "alloy",
      response_format: normalizeTtsResponseFormat(input.payload.responseFormat),
      speed: input.payload.speed,
      ...mergeOpenRouterOpenAIOptions(
        input.payload.extraBody,
        input.payload.instructions,
      ),
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
          ...(input.target.apiKey
            ? { Authorization: `Bearer ${input.target.apiKey}` }
            : {}),
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
      traceId: input.options?.traceId,
    });
  }
}
