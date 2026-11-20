import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "../normalize/protocols/openai-compatible";

export interface ProviderResponseCapture {
  headers?: Headers;
  statusCode?: number;
  /**
   * The last `usage` object of the provider's streamed response, read off the
   * wire. A provider that reports usage on a trailing chunk without `choices`
   * (the `stream_options.include_usage` shape) is otherwise invisible to a
   * caller that builds its final message from content-block events: LangChain
   * keeps that chunk's token totals but not the provider's own usage object,
   * and with it go the reported cost and the cached and reasoning token counts.
   */
  usage?: Record<string, unknown>;
  /**
   * The usage object of an Anthropic stream's `message_start` event: the
   * input side of the call, known as soon as the reply begins. LangChain
   * publishes a streamed reply's usage only with `message_delta`, near the
   * end, so for a reply cut before that this is the only figure there is.
   */
  startUsage?: Record<string, unknown>;
}

const responseCaptureStorage = new AsyncLocalStorage<ProviderResponseCapture>();

export function createProviderResponseCapture(): ProviderResponseCapture {
  return {};
}

export function runWithProviderResponseCapture<T>(
  capture: ProviderResponseCapture,
  run: () => T,
): T {
  return responseCaptureStorage.run(capture, run);
}

const USAGE_OBJECT = /"usage"\s*:\s*\{/u;

/** One SSE line as its data event, if the line is one that mentions usage. */
function usageEventOfSseLine(
  line: string,
): Record<string, unknown> | undefined {
  if (!line.startsWith("data:") || !USAGE_OBJECT.test(line)) {
    return undefined;
  }
  try {
    const event: unknown = JSON.parse(line.slice("data:".length));
    return isRecord(event) ? event : undefined;
  } catch {
    return undefined;
  }
}

/** Notes the usage one SSE data event reports, wherever the provider puts it. */
function noteSseUsage(
  event: Record<string, unknown>,
  capture: ProviderResponseCapture,
) {
  if (isRecord(event.usage)) {
    capture.usage = event.usage;
  }
  if (
    event.type === "message_start" &&
    isRecord(event.message) &&
    isRecord(event.message.usage)
  ) {
    capture.startUsage = event.message.usage;
  }
}

/**
 * Passes an SSE body through byte for byte while noting the usage object of
 * each complete line. It reads in step with the consumer, so the usage is
 * known before the consumer sees the stream end, and a cancel reaches the
 * provider's stream as it would without the tap.
 */
function tapSseUsage(
  body: ReadableStream<Uint8Array>,
  capture: ProviderResponseCapture,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  const scan = (text: string) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const event = usageEventOfSseLine(line.trimEnd());
      if (event) {
        noteSseUsage(event, capture);
      }
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        scan(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        scan(`${decoder.decode()}\n`);
      },
    }),
  );
}

function contentTypeIncludes(response: Response, type: string) {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes(type);
}

function isEventStream(response: Response) {
  return contentTypeIncludes(response, "text/event-stream");
}

/**
 * A non-streamed Responses API reply. LangChain builds its message from the
 * reply's output items and keeps the token counts, but not the provider's
 * usage object, and with it goes the cost a provider reports there. A
 * `chat/completions` reply needs no such reading: its usage object reaches
 * the gateway on the message itself.
 */
function isResponsesApiJsonReply(
  input: Parameters<typeof globalThis.fetch>[0],
  response: Response,
) {
  if (!response.ok || !contentTypeIncludes(response, "application/json")) {
    return false;
  }
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  try {
    return new URL(url).pathname.endsWith("/responses");
  } catch {
    return false;
  }
}

/** The `usage` object of a JSON reply, read from a copy so the reply stays unread. */
async function usageOfJsonReply(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await response.clone().json();
    return isRecord(body) && isRecord(body.usage) ? body.usage : undefined;
  } catch {
    return undefined;
  }
}

export function captureProviderResponseFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const capture = responseCaptureStorage.getStore();
    if (!capture) {
      return response;
    }

    capture.headers = new Headers(response.headers);
    capture.statusCode = response.status;
    // One capture can span several requests (a retry, a second attempt); the
    // usage belongs to the latest one only.
    capture.usage = undefined;
    capture.startUsage = undefined;
    if (!response.body) {
      return response;
    }
    if (!isEventStream(response)) {
      if (isResponsesApiJsonReply(input, response)) {
        capture.usage = await usageOfJsonReply(response);
      }
      return response;
    }

    const tapped = new Response(tapSseUsage(response.body, capture), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(tapped, "url", { value: response.url });
    return tapped;
  };
}
