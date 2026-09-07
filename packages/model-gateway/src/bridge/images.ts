import { GatewayCaller } from "../adapters/gateway-caller";
import { awaitWithSignal } from "../request-options";
import { getImageGenerationTransport } from "../adapters/registry";
import { normalizeGatewayError } from "../errors";
import type {
  ImageGenerateInput,
  ImageGenerateResult,
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "../types";

export async function runBridgeImageGeneration(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ImageGenerateInput;
  options?: RequestOptions;
}): Promise<ImageGenerateResult> {
  try {
    return await awaitWithSignal(input.options?.signal, () =>
      new GatewayCaller(input.options).call(async () => {
        input.options?.signal?.throwIfAborted();
        return getImageGenerationTransport(input.target.providerKind).execute({
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
