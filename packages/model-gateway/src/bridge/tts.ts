import { GatewayCaller } from "../adapters/gateway-caller";
import { awaitWithSignal } from "../request-options";
import { getTtsTransport } from "../adapters/registry";
import { ModelGatewayError, normalizeGatewayError } from "../errors";
import { ttsMimeTypeForFormat } from "../adapters/tts-utils";
import { sniffTtsAudioFormat } from "../tts/sniff";
import type {
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  TtsSpeechInput,
  TtsSpeechResult,
} from "../types";

/** Requested formats a mismatch is converted to; raw pcm cannot be verified. */
const CONVERTIBLE = new Set(["mp3", "opus", "flac", "wav", "aac"]);

export async function runBridgeTtsSpeech(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: TtsSpeechInput;
  options?: RequestOptions;
}): Promise<TtsSpeechResult> {
  try {
    const transport = getTtsTransport(input.target.providerKind);
    const requested = input.payload.responseFormat?.trim().toLowerCase();
    const native = transport.outputFormats;
    // Only an explicit request for a format the provider lacks is converted;
    // with no format given the provider's own default stands.
    const convertFrom =
      requested && native && !native.includes(requested)
        ? native[0]
        : undefined;
    const transcoder = input.config.ttsAudioTranscoder;
    if (convertFrom && !transcoder) {
      throw new ModelGatewayError({
        code: "CONFIGURATION",
        message: `TTS provider '${input.target.provider}' outputs only ${native?.join(" or ")}; converting to ${requested} needs an audio transcoder (ffmpeg), and none is configured`,
        retryable: false,
        provider: input.target.provider,
      });
    }
    const payload = convertFrom
      ? { ...input.payload, responseFormat: convertFrom }
      : input.payload;

    const result = await awaitWithSignal(input.options?.signal, () =>
      new GatewayCaller(input.options).call(async () => {
        input.options?.signal?.throwIfAborted();
        return transport.execute({
          target: input.target,
          payload,
          options: input.options,
          fetch: input.config.fetch,
        });
      }),
    );
    if (!requested) {
      return result;
    }

    // What the audio really is. A provider can return another format than the
    // one asked for, and label it wrongly, so the bytes decide where they can.
    const audio = new Uint8Array(result.audio);
    const actual = sniffTtsAudioFormat(audio) ?? convertFrom;
    if (!actual || actual === requested || !CONVERTIBLE.has(requested)) {
      return result;
    }
    if (!transcoder) {
      // No conversion available: keep the audio, but say what it is.
      return {
        ...result,
        mimeType: ttsMimeTypeForFormat(actual) ?? result.mimeType,
      };
    }

    const converted = await transcoder.transcode(
      { audio, fromFormat: actual, toFormat: requested },
      input.options?.signal,
    );
    if (converted.byteLength === 0) {
      throw new ModelGatewayError({
        code: "UPSTREAM",
        message: `Converting TTS audio from ${actual} to ${requested} produced no audio`,
        retryable: false,
        provider: input.target.provider,
      });
    }
    return {
      ...result,
      audio: converted.buffer.slice(
        converted.byteOffset,
        converted.byteOffset + converted.byteLength,
      ) as ArrayBuffer,
      mimeType: ttsMimeTypeForFormat(requested) ?? result.mimeType,
      raw: {
        ...result.raw,
        convertedFrom: actual,
        convertedTo: requested,
      },
    };
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
