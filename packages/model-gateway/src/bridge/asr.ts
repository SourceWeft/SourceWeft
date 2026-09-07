import { GatewayCaller } from "../adapters/gateway-caller";
import { awaitWithSignal } from "../request-options";
import { getAsrTransport } from "../adapters/registry";
import { normalizeGatewayError } from "../errors";
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
    return await awaitWithSignal(input.options?.signal, () =>
      new GatewayCaller(input.options).call(async () => {
        input.options?.signal?.throwIfAborted();
        return getAsrTransport(input.target.providerKind).execute({
          target: input.target,
          payload: input.payload,
          options: input.options,
          fetch: input.config.fetch,
        });
      }),
    );
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
