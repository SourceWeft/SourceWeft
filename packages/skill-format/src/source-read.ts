import { setTimeout as delay } from "node:timers/promises";
const TRANSIENT_SOURCE_ERRORS = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ARCHIVE_TIMEOUT",
]);
function transient(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: string; cause?: unknown };
    if (value.code && TRANSIENT_SOURCE_ERRORS.has(value.code)) return true;
    current = value.cause;
  }
  return false;
}
/** At most three GET/read attempts against the same immutable source. */
export async function retryTransientSourceRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (signal?.aborted || attempt >= 2 || !transient(error)) throw error;
      await delay(200 * 2 ** attempt, undefined, { signal });
    }
  }
}
