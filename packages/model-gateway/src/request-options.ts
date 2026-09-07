import type {
  RequestOptions,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
} from "./types";

/** Values are resolved once for each target, including an explicit zero retry budget. */
export function resolveRequestDefaults(
  config: Pick<ResolvedModelGatewayConfig, "timeoutMs" | "maxRetries">,
  target: Pick<ResolvedRequestTarget, "timeoutMs" | "maxRetries">,
  options?: RequestOptions,
): RequestOptions & { timeoutMs: number; maxRetries: number } {
  return {
    ...options,
    timeoutMs: options?.timeoutMs ?? target.timeoutMs ?? config.timeoutMs,
    maxRetries: options?.maxRetries ?? target.maxRetries ?? config.maxRetries,
  };
}

/** A fresh timeout belongs to one target attempt, including its SDK retries. */
export function resolveRequestOptions(
  config: Pick<ResolvedModelGatewayConfig, "timeoutMs" | "maxRetries">,
  target: Pick<ResolvedRequestTarget, "timeoutMs" | "maxRetries">,
  options?: RequestOptions,
) {
  const resolved = resolveRequestDefaults(config, target, options);
  const timeout = AbortSignal.timeout(resolved.timeoutMs);
  return {
    ...resolved,
    signal: options?.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  };
}

/** SDKs without per-call embedding options still receive the attempt signal. */
export function fetchWithRequestSignal(
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): typeof globalThis.fetch {
  if (!signal) return fetch;
  return (input, init) => {
    signal.throwIfAborted();
    const sdkSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetch(input, {
      ...init,
      signal: sdkSignal ? AbortSignal.any([signal, sdkSignal]) : signal,
    });
  };
}

/** Also interrupt SDK retry backoff; the fetch/failed-attempt guards stop later IO. */
export async function awaitWithSignal<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}
