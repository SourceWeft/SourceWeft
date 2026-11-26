/**
 * The limit on one server-side read of the public catalog (MCP and skills)
 * from the web app to the API, response body included (Issue #767).
 *
 * A healthy read answers in well under a second, so eight seconds is only
 * reached when the API is stalled. A detail page makes at most three such
 * reads one after another (manifest and detail together, then the related
 * list, then the tool change log), so even the worst case ends long before
 * the edge proxy's 100-second origin limit, and the visitor gets an error
 * status instead of a connection that hangs.
 */
export const CATALOG_REQUEST_TIMEOUT_MS = 8_000;

/** A fresh abort signal for one catalog read made with plain `fetch`. */
export function catalogRequestSignal(): AbortSignal {
  return AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS);
}

/** The SDK's code for a read cut off by the limit above. */
const MARKET_REQUEST_TIMEOUT_CODE = "MARKET_REQUEST_TIMEOUT";

export function isCatalogTimeout(error: unknown) {
  return (
    (error as { code?: unknown } | null)?.code === MARKET_REQUEST_TIMEOUT_CODE
  );
}

/**
 * How long a timed-out read keeps failing at once. Long enough to cover the
 * error page that follows a failed render, short enough that a recovered API
 * is asked again almost immediately.
 */
export const CATALOG_TIMEOUT_REUSE_MS = 2_000;
const MAX_REMEMBERED_TIMEOUTS = 500;

/**
 * Wraps a strict catalog read so that a timeout is answered once per request,
 * not twice. When a page fails, Next renders its error page in a new pass
 * whose metadata asks for the same data again; without this that pass waits
 * out a second full timeout before the response can end.
 *
 * Only timeouts are remembered, in this process's memory, for
 * `CATALOG_TIMEOUT_REUSE_MS`. Results, 404s and other errors are not, and
 * nothing here touches the data cache.
 */
export function failFastAfterTimeout<Args extends unknown[], Result>(
  name: string,
  read: (...args: Args) => Promise<Result>,
  now: () => number = Date.now,
): (...args: Args) => Promise<Result> {
  const recent = new Map<string, { error: unknown; until: number }>();
  return async (...args) => {
    const key = `${name}:${JSON.stringify(args)}`;
    const remembered = recent.get(key);
    if (remembered) {
      if (now() < remembered.until) {
        throw remembered.error;
      }
      recent.delete(key);
    }
    try {
      return await read(...args);
    } catch (error) {
      if (isCatalogTimeout(error)) {
        if (recent.size >= MAX_REMEMBERED_TIMEOUTS) {
          recent.clear();
        }
        recent.set(key, { error, until: now() + CATALOG_TIMEOUT_REUSE_MS });
      }
      throw error;
    }
  };
}
