import { resolveRequestTarget } from "../config";
import { normalizeGatewayError } from "../errors";
import { runBridgeRerank } from "../bridge/rerank";
import type {
  RequestOptions,
  RerankInput,
  RerankResult,
  ResolvedModelGatewayConfig,
} from "../types";

export class ModelGatewayRerankEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async rank(
    input: RerankInput,
    options?: RequestOptions,
  ): Promise<RerankResult> {
    const target = await resolveRequestTarget(this.config, input);
    try {
      return await runBridgeRerank({
        config: this.config,
        target,
        payload: input,
        options,
      });
    } catch (error) {
      throw normalizeGatewayError(error);
    }
  }
}
