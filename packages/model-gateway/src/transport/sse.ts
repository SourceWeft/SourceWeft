import { createParser, type EventSourceMessage } from "eventsource-parser";
import { ModelGatewayError } from "../errors";

export interface SSEEvent {
  event?: string;
  id?: string;
  data: string;
}

export async function* parseSSE(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) {
    throw new ModelGatewayError({
      code: "UPSTREAM",
      message: "Model gateway streaming response body is missing",
      retryable: true,
    });
  }

  const queue: SSEEvent[] = [];
  let parserError: ModelGatewayError | undefined;

  const parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      queue.push({
        event: event.event,
        id: event.id,
        data: event.data,
      });
    },
    onError: (error) => {
      parserError = new ModelGatewayError({
        code: "UPSTREAM",
        message: `Failed to parse SSE stream: ${error.message}`,
        retryable: false,
      });
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      parser.feed(decoder.decode(value, { stream: true }));

      if (parserError) {
        throw parserError;
      }

      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) {
          continue;
        }
        yield next;
      }
    }

    parser.feed(decoder.decode());

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }
      yield next;
    }
  } finally {
    reader.releaseLock();
  }
}
