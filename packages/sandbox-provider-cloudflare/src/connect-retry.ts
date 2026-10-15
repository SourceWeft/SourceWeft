import { setTimeout as wait } from "node:timers/promises";

/** Only transport failures which prove no HTTP request reached the bridge.
 * Generic resets, response timeouts and broken streams may follow execution.
 */
export function failedBeforeRequest(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 6 && current && typeof current === "object" && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const value = current as {
      code?: string;
      syscall?: string;
      message?: string;
      cause?: unknown;
    };
    if (value.code === "UND_ERR_CONNECT_TIMEOUT") return true;
    if (
      value.syscall === "getaddrinfo" &&
      ["EAI_AGAIN", "ENOTFOUND"].includes(value.code ?? "")
    )
      return true;
    if (
      value.syscall === "connect" &&
      ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(
        value.code ?? "",
      )
    )
      return true;
    if (
      value.code === "ECONNRESET" &&
      value.message?.includes("before secure TLS connection was established")
    )
      return true;
    current = value.cause;
  }
  return false;
}

export async function fetchAfterConnectRetry(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  retryDelayMs = 100,
): Promise<Response> {
  const replayable =
    init.body == null ||
    typeof init.body === "string" ||
    init.body instanceof ArrayBuffer ||
    ArrayBuffer.isView(init.body);
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    try {
      return await fetcher(url, init);
    } catch (error) {
      if (
        attempt >= 2 ||
        init.signal?.aborted ||
        !replayable ||
        !failedBeforeRequest(error)
      )
        throw error;
      await wait(retryDelayMs * 2 ** attempt, undefined, {
        signal: init.signal ?? undefined,
      });
    }
  }
}
