import { awaitWithSignal } from "../request-options";
import {
  runWithProviderResponseCapture,
  type ProviderResponseCapture,
} from "../observation/response-capture";
import type { ResolvedModelGatewayConfig } from "../types";

export type StreamIterator<T> = {
  next(): Promise<IteratorResult<T>>;
  close(): Promise<void>;
};

/** Own one SDK iterator, including a stream that opens after cancellation. */
export async function openStreamIterator<T>(input: {
  open(signal: AbortSignal): Promise<AsyncIterable<T>>;
  signal?: AbortSignal;
  capture?: ProviderResponseCapture;
  logger: ResolvedModelGatewayConfig["logger"];
}): Promise<StreamIterator<T>> {
  const run = <R>(fn: () => R): R =>
    input.capture ? runWithProviderResponseCapture(input.capture, fn) : fn();
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  const pending = Promise.resolve()
    .then(() =>
      run(() => {
        signal.throwIfAborted();
        return input.open(signal);
      }),
    )
    .then((stream) => {
      const iterator = run(() => stream[Symbol.asyncIterator]());
      let closed = false;
      let drained = false;
      return {
        next: async () => {
          const next = await awaitWithSignal(signal, () =>
            run(() => iterator.next()),
          );
          drained = Boolean(next.done);
          return next;
        },
        close: async () => {
          if (closed) return;
          closed = true;
          // LangChain can prefetch its next chunk. Interrupt that read before
          // awaiting return(), which otherwise queues behind the pending read.
          if (!drained) run(() => controller.abort());
          await run(() => iterator.return?.());
        },
      };
    });
  try {
    return await awaitWithSignal(signal, () => pending);
  } catch (error) {
    // An SDK may ignore cancellation while opening. Its eventual resource is
    // still owned here; a late rejection has already been handled by the race.
    void pending
      .then(
        (iterator) => iterator.close(),
        () => {},
      )
      .catch(() => {
        input.logger.warn?.("model-gateway.stream.cleanup.failed");
      });
    throw error;
  }
}

export async function closeStreamIterator(
  iterator: StreamIterator<unknown> | undefined,
  logger: ResolvedModelGatewayConfig["logger"],
  hasPrimaryError: boolean,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!iterator) return;
    // Abort has already reached the SDK. An iterator whose return() ignores
    // cancellation must not keep a timed-out/user-stopped turn alive forever.
    await Promise.race([
      iterator.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DOMException(
                "Model stream cleanup exceeded 1000ms after cancellation",
                "TimeoutError",
              ),
            ),
          1_000,
        );
      }),
    ]);
  } catch (error) {
    if (!hasPrimaryError) throw error;
    // Cleanup must not change failover/error classification of the request.
    logger.warn?.("model-gateway.stream.cleanup.failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
