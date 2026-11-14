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

export async function runBridgeAsrTranscription(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: AsrTranscribeInput;
  options?: RequestOptions;
}): Promise<AsrTranscribeResult> {
  try {
    const transport = getAsrTransport(input.target.providerKind);
    return await transcribeWithinAsrLimits({
      limits: transport.limits(input.target),
      payload: input.payload,
      preparer: input.config.asrAudioPreparer,
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
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
