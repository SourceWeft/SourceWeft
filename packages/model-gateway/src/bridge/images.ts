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
    return getImageGenerationTransport(input.target.providerKind).execute({
      target: input.target,
      payload: input.payload,
      options: input.options,
      fetch: input.config.fetch,
    });
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
