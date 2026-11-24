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
   * The upstream that served a streamed response, from the first event's
   * top-level `provider` field (OpenRouter names the host it routed to, e.g.
   * "Sail Research").
   */
  upstreamProvider?: string;
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
const PROVIDER_STRING = /"provider"\s*:\s*"/u;

/** The data event of one SSE line, if it may carry what the capture notes. */
function eventOfSseLine(
  line: string,
  capture: ProviderResponseCapture,
): Record<string, unknown> | undefined {
  if (
    !line.startsWith("data:") ||
    !(
      USAGE_OBJECT.test(line) ||
      (capture.upstreamProvider === undefined && PROVIDER_STRING.test(line))
    )
  ) {
    return undefined;
  }
  try {
    const event: unknown = JSON.parse(line.slice("data:".length));
    return isRecord(event) ? event : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Passes an SSE body through byte for byte while noting the usage object and
 * the serving upstream of each complete line. It reads in step with the consumer, so the usage is
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
      const event = eventOfSseLine(line.trimEnd(), capture);
      if (!event) continue;
      if (isRecord(event.usage)) {
        capture.usage = event.usage;
      }
      if (
        capture.upstreamProvider === undefined &&
        typeof event.provider === "string" &&
        event.provider.trim().length > 0
      ) {
        capture.upstreamProvider = event.provider.trim();
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

function isEventStream(response: Response) {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
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
    capture.upstreamProvider = undefined;
    if (!response.body || !isEventStream(response)) {
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
