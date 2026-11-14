import { GatewayCaller } from "../adapters/gateway-caller";
import { awaitWithSignal } from "../request-options";
import { getAsrTransport } from "../adapters/registry";
import { normalizeGatewayError } from "../errors";
import { transcribeWithinAsrLimits } from "../asr/run";
import type {
  AsrTranscribeInput,
  AsrTranscribeResult,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

/**
 * The duration is needed twice in one call, to check the provider's limit and
 * to report usage. Measure the file once.
 */
function measureOnce(
  preparer: ResolvedModelGatewayConfig["asrAudioPreparer"],
): ResolvedModelGatewayConfig["asrAudioPreparer"] {
  if (!preparer) return undefined;
  let measured: Promise<number | null> | undefined;
  return {
    probeDurationSec: (source, signal) =>
      (measured ??= preparer.probeDurationSec(source, signal)),
    normalize: (source, signal) => preparer.normalize(source, signal),
  };
}

/**
 * ASR providers bill by audio duration and report no usage, so the duration is
 * the call's usage. It comes from the provider's own figure (or the decoded
 * length when the audio was split); failing that, from measuring the file.
 * With no figure the usage stays empty and the cost stays unknown.
 */
async function withAsrAudioSeconds(
  result: AsrTranscribeResult,
  input: {
    payload: AsrTranscribeInput;
    preparer?: ResolvedModelGatewayConfig["asrAudioPreparer"];
    signal?: AbortSignal;
  },
): Promise<AsrTranscribeResult> {
  let seconds =
    result.duration ??
    (result.inputLengthMs !== undefined
      ? result.inputLengthMs / 1000
      : undefined);
  if (seconds === undefined && input.preparer) {
    const { audio } = input.payload;
    const bytes =
      audio instanceof Uint8Array
        ? audio
        : new Uint8Array(
            audio instanceof ArrayBuffer ? audio : await audio.arrayBuffer(),
          );
    seconds =
      (await input.preparer
        .probeDurationSec(
          {
            audio: bytes,
            fileName: input.payload.fileName,
            mimeType: input.payload.mimeType,
          },
          input.signal,
        )
        .catch(() => null)) ?? undefined;
  }
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return result;
  }
  const usage = { ...result.usage, inputAudioSeconds: seconds };
  return {
    ...result,
    usage,
    observation: result.observation
      ? { ...result.observation, usage }
      : undefined,
  };
}

export async function runBridgeAsrTranscription(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: AsrTranscribeInput;
  options?: RequestOptions;
}): Promise<AsrTranscribeResult> {
  try {
    const transport = getAsrTransport(input.target.providerKind);
    const preparer = measureOnce(input.config.asrAudioPreparer);
    const result = await transcribeWithinAsrLimits({
      limits: transport.limits(input.target),
      payload: input.payload,
      preparer,
      provider: input.target.provider,
      signal: input.options?.signal,
      // One provider request; a split transcription makes one per chunk, each
      // with its own retries.
      executeOne: (payload, signal) => {
        const options = { ...input.options, signal };
        return awaitWithSignal(signal, () =>
          new GatewayCaller(options).call(async () => {
            signal?.throwIfAborted();
            return transport.execute({
              target: input.target,
              payload,
              options,
              fetch: input.config.fetch,
            });
          }),
        );
      },
    });
    return withAsrAudioSeconds(result, {
      payload: input.payload,
      preparer,
      signal: input.options?.signal,
    });
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
