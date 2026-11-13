import assert from "node:assert/strict";
import { test } from "node:test";
import { DeepSeekWebProvider } from "../src/providers/deepseek";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function createFetch(
  responder: (call: Call, index: number) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const searchInput = { query: "hello", limit: 5 };

test("search sends the mapped request with bearer auth", async () => {
  const { calls, fetchImpl } = createFetch(() => json({ results: [] }));
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  await provider.search({
    query: "  hello   world ",
    limit: 80,
    includeContent: true,
    lang: "zh",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer test-key",
  );
  assert.deepEqual(calls[0]?.body, {
    query: "hello world lang:zh",
    count: 10,
    need_content: true,
  });
});

test("search without content allows up to 50 results", async () => {
  const { calls, fetchImpl } = createFetch(() => json({ results: [] }));
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  await provider.search({ query: "hello", limit: 80, includeContent: false });

  assert.equal(calls[0]?.body.count, 50);
  assert.equal(calls[0]?.body.need_content, false);
});

test("search ignores a malformed lang value", async () => {
  const { calls, fetchImpl } = createFetch(() => json({ results: [] }));
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  await provider.search({ ...searchInput, lang: "zh site:evil.com" });

  assert.equal(calls[0]?.body.query, "hello");
});

test("search truncates the query to 128 Unicode characters including lang", async () => {
  const { calls, fetchImpl } = createFetch(() => json({ results: [] }));
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  await provider.search({ query: "𠮷".repeat(200), limit: 5, lang: "zh" });

  const sent = String(calls[0]?.body.query);
  assert.ok(Array.from(sent).length <= 128);
  assert.ok(sent.endsWith(" lang:zh"));
  assert.ok(!sent.includes("�"));
});

test("search maps results, orders by rerank score and truncates content", async () => {
  const { fetchImpl } = createFetch(() =>
    json({
      results: [
        {
          rerank_score: 0.2,
          title: "Low",
          url: "https://example.com/low",
          snippet: "low snippet",
        },
        {
          rerank_score: 0.9,
          title: "High",
          url: "https://example.com/high",
          summary: "high summary",
          content: "a".repeat(13_000),
          site_name: "Example",
          date: "2026-11-01T00:00:00Z",
        },
      ],
    }),
  );
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  const result = await provider.search(searchInput);

  assert.equal(result.provider, "deepseek");
  assert.equal(result.count, 2);
  const [first, second] = result.results;
  assert.equal(first?.title, "High");
  assert.equal(first?.snippet, "high summary");
  assert.equal(first?.markdown?.length, 12_000);
  assert.equal(first?.truncated, true);
  assert.equal(first?.source, "Example");
  assert.equal(first?.publishedAt, "2026-11-01T00:00:00Z");
  assert.equal(second?.title, "Low");
  assert.equal(second?.markdown, undefined);
});

test("search drops non-public URLs", async () => {
  const { fetchImpl } = createFetch(() =>
    json({
      results: [
        { title: "Local", url: "http://localhost/x" },
        { title: "Public", url: "https://example.com/ok" },
      ],
    }),
  );
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  const result = await provider.search(searchInput);

  assert.equal(result.count, 1);
  assert.equal(result.results[0]?.title, "Public");
});

test("search throws on HTTP errors without leaking the key", async () => {
  const { fetchImpl } = createFetch(() =>
    json({ error: { message: "rate limited" } }, 429),
  );
  const provider = new DeepSeekWebProvider("secret-key-123", { fetchImpl });

  await assert.rejects(
    () => provider.search(searchInput),
    (error: Error) => {
      assert.match(error.message, /429/);
      assert.match(error.message, /rate limited/);
      assert.doesNotMatch(error.message, /secret-key-123/);
      return true;
    },
  );
});

test("fetch posts each url and maps title and content", async () => {
  const { calls, fetchImpl } = createFetch(() =>
    json({ title: " T ", content: "word ".repeat(100) }),
  );
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  const result = await provider.fetch({ items: [{ url: "https://example.com/a" }] });

  assert.equal(calls[0]?.url, "https://api.deepseek.com/v1/tools/fetch");
  assert.deepEqual(calls[0]?.body, { url: "https://example.com/a" });
  assert.equal(result.provider, "deepseek");
  assert.equal(result.count, 1);
  assert.equal(result.results[0]?.title, "T");
  assert.equal(result.results[0]?.wordCount, 100);
  assert.equal(result.results[0]?.truncated, false);
  assert.equal(result.results[0]?.error, undefined);
});

test("fetch truncates content to 50000 characters", async () => {
  const { fetchImpl } = createFetch(() => json({ title: "T", content: "a".repeat(60_000) }));
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  const result = await provider.fetch({ items: [{ url: "https://example.com/a" }] });

  assert.equal(result.results[0]?.markdown.length, 50_000);
  assert.equal(result.results[0]?.truncated, true);
});

test("fetch reports empty content as an error", async () => {
  const { fetchImpl } = createFetch(() => json({ title: "T", content: "" }));
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  const result = await provider.fetch({ items: [{ url: "https://example.com/a" }] });

  assert.equal(result.count, 0);
  assert.match(result.results[0]?.error ?? "", /no content/i);
});

test("fetch rejects private URLs without calling the API", async () => {
  const { calls, fetchImpl } = createFetch(() => json({ title: "T", content: "x" }));
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  const result = await provider.fetch({
    items: [{ url: "http://127.0.0.1/" }, { url: "https://example.com/a" }],
  });

  assert.equal(calls.length, 1);
  assert.ok(result.results[0]?.error);
  assert.equal(result.results[1]?.error, undefined);
  assert.equal(result.count, 1);
});

test("fetch retries once on 429 and then succeeds", async () => {
  const { calls, fetchImpl } = createFetch((_call, index) =>
    index === 0
      ? json({ error: { message: "slow down" } }, 429, { "Retry-After": "1" })
      : json({ title: "T", content: "ok content" }),
  );
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl, retryDelayMs: 0 });

  const result = await provider.fetch({ items: [{ url: "https://example.com/a" }] });

  assert.equal(calls.length, 2);
  assert.equal(result.count, 1);
});

test("fetch turns repeated 429, 404 and 403 into item errors without throwing", async () => {
  for (const status of [429, 404, 403]) {
    const { fetchImpl } = createFetch(() =>
      json({ error: { message: `status ${status}` } }, status),
    );
    const provider = new DeepSeekWebProvider("test-key", { fetchImpl, retryDelayMs: 0 });

    const result = await provider.fetch({ items: [{ url: "https://example.com/a" }] });

    assert.equal(result.count, 0);
    assert.match(result.results[0]?.error ?? "", new RegExp(String(status)));
  }
});

test("fetch times out per item", async () => {
  const { fetchImpl } = createFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = call.init.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl, fetchTimeoutMs: 20 });

  const result = await provider.fetch({ items: [{ url: "https://example.com/a" }] });

  assert.equal(result.count, 0);
  assert.match(result.results[0]?.error ?? "", /timed out/i);
});

test("fetch handles at most 5 items, all concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const { calls, fetchImpl } = createFetch(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return json({ title: "T", content: "ok content" });
  });
  const provider = new DeepSeekWebProvider("test-key", { fetchImpl });

  const result = await provider.fetch({
    items: Array.from({ length: 6 }, (_, index) => ({
      url: `https://example.com/${index}`,
    })),
  });

  assert.equal(calls.length, 5);
  assert.equal(result.results.length, 5);
  assert.equal(maxActive, 5);
});
