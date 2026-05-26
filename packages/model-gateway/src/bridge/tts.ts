import { getTtsTransport } from "../adapters/registry";
import { normalizeGatewayError } from "../errors";
import type {
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  TtsSpeechInput,
  TtsSpeechResult,
} from "../types";

export async function runBridgeTtsSpeech(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: TtsSpeechInput;
  options?: RequestOptions;
}): Promise<TtsSpeechResult> {
  try {
    return await getTtsTransport(input.target.providerKind).execute({
      target: input.target,
      payload: input.payload,
      options: input.options,
      fetch: input.config.fetch,
    });
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}
