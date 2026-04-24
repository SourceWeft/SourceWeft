import { resolveRequestTarget } from "../config";
import { normalizeGatewayError } from "../errors";
import { runBridgeChatComplete, runBridgeChatStream } from "../bridge/chat";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  RequestOptions,
  ResolvedModelGatewayConfig,
} from "../types";

export class ModelGatewayChatEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async complete(
    input: ChatCompleteInput,
    options?: RequestOptions,
  ): Promise<ChatCompleteResult> {
    const target = await resolveRequestTarget(this.config, input);
    try {
      return await runBridgeChatComplete({
        config: this.config,
        target,
        payload: input,
        options,
      });
    } catch (error) {
      throw normalizeGatewayError(error);
    }
  }

  async *stream(
    input: ChatStreamInput,
    options?: RequestOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const target = await resolveRequestTarget(this.config, input);
    yield* runBridgeChatStream({
      config: this.config,
      target,
      payload: input,
      options,
    });
  }
}
