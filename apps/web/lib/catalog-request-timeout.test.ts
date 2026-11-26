import { describe, expect, it, vi } from "vitest";
import {
  MARKET_REQUEST_TIMEOUT_CODE,
  MarketClient,
  MarketClientError,
} from "@sourceweft/market-sdk";

import {
  CATALOG_REQUEST_TIMEOUT_MS,
  CATALOG_TIMEOUT_REUSE_MS,
  catalogRequestSignal,
  failFastAfterTimeout,
  isCatalogTimeout,
} from "./catalog-request-timeout";

// A server that accepts the request and never answers: settles only when the
// request's own signal aborts, as `fetch` does.
function stalledFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      }),
  );
}

describe("MarketClient request timeout", () => {
  it("fails a stalled request once the timeout passes", async () => {
    const fetchImpl = stalledFetch();
    const client = new MarketClient({
      baseUrl: "https://api.test",
      fetch: fetchImpl as typeof fetch,
      timeoutMs: 20,
    });
    const startedAt = Date.now();
    const error = await client.getMcp("io.github.o/r").catch((e) => e);
    expect(error).toBeInstanceOf(MarketClientError);
    expect(error).toMatchObject({
      code: MARKET_REQUEST_TIMEOUT_CODE,
      status: 504,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails a response whose body stalls after the headers", async () => {
    const client = new MarketClient({
      baseUrl: "https://api.test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal!.reason),
              );
            }),
        }) as Response) as typeof fetch,
      timeoutMs: 20,
    });
    await expect(client.getMcp("io.github.o/r")).rejects.toMatchObject({
      code: MARKET_REQUEST_TIMEOUT_CODE,
    });
  });

  it("is not a 404: a timed-out read never reads as not found", async () => {
    const client = new MarketClient({
      baseUrl: "https://api.test",
      fetch: stalledFetch() as typeof fetch,
      timeoutMs: 20,
    });
    const error = await client.getMcpManifest("x").catch((e) => e);
    expect(error.status).not.toBe(404);
  });

  it("keeps an API error as it is when it arrives in time", async () => {
    const client = new MarketClient({
      baseUrl: "https://api.test",
      fetch: (async () =>
        new Response(JSON.stringify({ code: "NOT_FOUND", message: "gone" }), {
          status: 404,
        })) as typeof fetch,
      timeoutMs: 1_000,
    });
    await expect(client.getMcp("x")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("sends no signal and sets no limit when no timeout is given", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const client = new MarketClient({
      baseUrl: "https://api.test",
      fetch: fetchImpl as typeof fetch,
    });
    await client.listMcpCategories();
    expect(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].signal,
    ).toBeUndefined();
  });

  it("rejects a timeout that is not a positive number", () => {
    expect(
      () => new MarketClient({ baseUrl: "https://api.test", timeoutMs: 0 }),
    ).toThrow(RangeError);
  });
});

describe("catalogRequestSignal", () => {
  it("is a fresh, not yet aborted signal for each read", () => {
    expect(CATALOG_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    const first = catalogRequestSignal();
    expect(first.aborted).toBe(false);
    expect(catalogRequestSignal()).not.toBe(first);
  });
});

describe("failFastAfterTimeout", () => {
  const timeout = () =>
    new MarketClientError({
      code: MARKET_REQUEST_TIMEOUT_CODE,
      message: "timed out",
      status: 504,
    });

  it("recognises the SDK's timeout error and nothing else", () => {
    expect(isCatalogTimeout(timeout())).toBe(true);
    expect(
      isCatalogTimeout(
        new MarketClientError({ code: "NOT_FOUND", message: "", status: 404 }),
      ),
    ).toBe(false);
    expect(isCatalogTimeout(new Error("down"))).toBe(false);
    expect(isCatalogTimeout(null)).toBe(false);
  });

  it("answers the same read at once for a moment after a timeout, then asks again", async () => {
    let clock = 0;
    const error = timeout();
    const read = vi.fn<(id: string, locale?: string) => Promise<string>>();
    read.mockRejectedValue(error);
    const guarded = failFastAfterTimeout("detail", read, () => clock);

    await expect(guarded("a", "en")).rejects.toBe(error);
    // The error page's metadata pass, right after: no second wait.
    await expect(guarded("a", "en")).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    // Other arguments are other reads.
    await expect(guarded("a", "zh-CN")).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(2);

    clock = CATALOG_TIMEOUT_REUSE_MS;
    read.mockResolvedValue("back");
    await expect(guarded("a", "en")).resolves.toBe("back");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("remembers neither results, nor a 404, nor any other failure", async () => {
    const read = vi.fn<(id: string) => Promise<string>>();
    const guarded = failFastAfterTimeout("detail", read, () => 0);

    read.mockResolvedValue("ok");
    await guarded("a");
    await guarded("a");
    expect(read).toHaveBeenCalledTimes(2);

    const gone = new MarketClientError({
      code: "NOT_FOUND",
      message: "gone",
      status: 404,
    });
    read.mockRejectedValue(gone);
    await expect(guarded("b")).rejects.toBe(gone);
    read.mockResolvedValue("published");
    await expect(guarded("b")).resolves.toBe("published");

    read.mockRejectedValue(new Error("connection refused"));
    await expect(guarded("c")).rejects.toThrow("connection refused");
    read.mockResolvedValue("up");
    await expect(guarded("c")).resolves.toBe("up");
  });
});
