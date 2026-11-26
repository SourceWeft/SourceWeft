import { WordPressError } from "./errors";
import {
  MAX_REQUESTS,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
  REQUEST_TIMEOUT_MS,
} from "./limits";

/** Limits a test may lower; production uses the constants in `limits.ts`. */
export type ClientLimits = {
  maxRequests: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  minRequestGapMs: number;
};

export type TransportInput = {
  /** The host fetch scope: it owns the address policy. */
  fetch: typeof fetch;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  limits?: Partial<ClientLimits>;
};

/** A GET transport shared by the client and REST-root discovery: it owns the
 * request budget, the minimum gap, retries and the redirect refusal; the
 * caller's `handle` owns reading the final response body and mapping its
 * status. One instance holds one budget and one gap clock. */
export type Transport = {
  /** One logical GET to `url` with `headers` (plus `redirect: "manual"`). The
   * final non-retryable response (200, 4xx, or a persistent 5xx) and the read
   * signal are passed to `handle`. A 3xx is `BLOCKED_ENDPOINT` and never
   * followed; a persistent 429 is `RATE_LIMITED`; a network error or timeout
   * is `SITE_UNREACHABLE`; exceeding the budget is `TOO_LARGE`. */
  request<T>(
    url: string,
    headers: Record<string, string>,
    handle: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  /** Requests issued through this transport (retries included). */
  requestCount(): number;
};

class Timeout {}

/** Rejects when the signal aborts, so a fetch or read that ignores it cannot hang. */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new Timeout());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Timeout());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away; a failed cancel changes nothing.
  }
}

/** Milliseconds to wait before a retry: a `Retry-After` header (seconds or an
 * HTTP date) wins, capped; otherwise a bounded backoff. */
function retryAfterMs(
  response: Response,
  attempt: number,
  now: () => number,
  maxDelay: number,
): number {
  const backoff = Math.min(500 * (attempt + 1), maxDelay);
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return backoff;
  if (/^\d{1,9}$/.test(header))
    return Math.min(Number(header) * 1000, maxDelay);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now()), maxDelay);
  return backoff;
}

export function createTransport(input: TransportInput): Transport {
  const now = input.now ?? Date.now;
  const external = input.signal;
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const limits: ClientLimits = {
    maxRequests: MAX_REQUESTS,
    maxRetries: MAX_RETRIES,
    maxRetryDelayMs: MAX_RETRY_DELAY_MS,
    minRequestGapMs: MIN_REQUEST_GAP_MS,
    ...input.limits,
  };

  let requestCount = 0;
  let lastRequestAt: number | null = null;

  function wait(ms: number): Promise<void> {
    if (input.sleep) return input.sleep(ms);
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        external?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      external?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function request<T>(
    url: string,
    headers: Record<string, string>,
    handle: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
      // Checked before anything is sent, so the ceiling is never exceeded.
      if (requestCount >= limits.maxRequests) {
        throw new WordPressError("TOO_LARGE");
      }
      requestCount += 1;
      if (lastRequestAt !== null) {
        const elapsed = now() - lastRequestAt;
        if (elapsed < limits.minRequestGapMs) {
          await wait(limits.minRequestGapMs - elapsed);
          if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
        }
      }

      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(
        () => controller.abort(new Timeout()),
        timeoutMs,
      );
      const onExternalAbort = () => controller.abort(new Timeout());
      external?.addEventListener("abort", onExternalAbort, { once: true });

      let retry = false;
      let waitMs = Math.min(500 * (attempt + 1), limits.maxRetryDelayMs);
      try {
        const response = await abortable(
          input.fetch(url, {
            method: "GET",
            headers,
            // The host scope follows a cross-origin redirect unless told not to.
            // `manual` hands any 3xx back, which is refused below: a credential
            // never follows a redirect and no endpoint is reached indirectly.
            redirect: "manual",
            signal,
          }),
          signal,
        );
        const { status } = response;
        if (status >= 300 && status < 400) {
          await discard(response);
          throw new WordPressError("BLOCKED_ENDPOINT");
        }
        const retryable = status === 429 || (status >= 500 && status <= 599);
        if (retryable && attempt < limits.maxRetries) {
          if (status === 429) {
            waitMs = retryAfterMs(
              response,
              attempt,
              now,
              limits.maxRetryDelayMs,
            );
          }
          await discard(response);
          retry = true;
        } else if (status === 429) {
          await discard(response);
          throw new WordPressError("RATE_LIMITED");
        } else {
          return await handle(response, signal);
        }
      } catch (error) {
        if (error instanceof WordPressError) throw error;
        if (external?.aborted) throw new WordPressError("SITE_UNREACHABLE");
        if (attempt >= limits.maxRetries) {
          throw new WordPressError("SITE_UNREACHABLE");
        }
        retry = true;
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
        // The gap is measured from the end of the response, body included.
        lastRequestAt = now();
      }
      if (retry) {
        await wait(waitMs);
        attempt += 1;
      }
    }
  }

  return {
    request,
    requestCount: () => requestCount,
  };
}
