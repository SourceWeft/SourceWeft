import { HttpClientError } from "@sourceweft/sdk";

/** Backoff before the single retry of a request that failed with HTTP 503. */
export const SERVICE_UNAVAILABLE_RETRY_DELAY_MS = 500;

type RetryOptions = {
  delayMs?: number;
  wait?: (ms: number) => Promise<void>;
};

function defaultWait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isServiceUnavailableError(error: unknown): boolean {
  return error instanceof HttpClientError && error.status === 503;
}

/**
 * Run `request`, retrying it exactly once after a short backoff when it fails
 * with HTTP 503 (a transient edge/upstream outage). Any other failure, and a
 * second 503, propagate unchanged.
 */
export async function retryOnceOnServiceUnavailable<T>(
  request: () => Promise<T>,
  {
    delayMs = SERVICE_UNAVAILABLE_RETRY_DELAY_MS,
    wait = defaultWait,
  }: RetryOptions = {},
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!isServiceUnavailableError(error)) {
      throw error;
    }
    await wait(delayMs);
    return request();
  }
}
