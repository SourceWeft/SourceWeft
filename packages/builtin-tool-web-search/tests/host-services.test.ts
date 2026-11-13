import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostWebProvider } from "../src/host-services";

type Warning = { message: string; meta?: Record<string, unknown> };

function setup(vars: Record<string, string>) {
  const warnings: Warning[] = [];
  const input = {
    env: {
      baseUrl: "https://app.example.test",
      get: (name: string) => vars[name],
    },
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, ...(meta ? { meta } : {}) });
      },
    },
  };
  return { input, warnings };
}

async function resolve(vars: Record<string, string>) {
  const { input, warnings } = setup(vars);
  const provider = await createHostWebProvider(input);
  return { provider, warnings };
}

test("unset WEB_PROVIDER keeps the AnyCrawl behavior", async () => {
  const { provider } = await resolve({ ANYCRAWL_API_KEY: "a" });
  assert.equal(provider?.name, "anycrawl");
});

test("unset WEB_PROVIDER with no AnyCrawl key means no provider", async () => {
  const { provider } = await resolve({});
  assert.equal(provider, null);
});

test("a DeepSeek key alone never enables web tools", async () => {
  const { provider } = await resolve({
    DEEPSEEK_API_KEY: "d",
    DEEPSEEK_WEB_API_KEY: "w",
    DEEPSEEK_ENABLED: "true",
  });
  assert.equal(provider, null);
});

test("WEB_PROVIDER=deepseek selects DeepSeek with DEEPSEEK_API_KEY", async () => {
  const { provider } = await resolve({ WEB_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "d" });
  assert.equal(provider?.name, "deepseek");
});

test("WEB_PROVIDER is trimmed and case-insensitive", async () => {
  const { provider } = await resolve({ WEB_PROVIDER: " DeepSeek ", DEEPSEEK_API_KEY: "d" });
  assert.equal(provider?.name, "deepseek");
});

test("DEEPSEEK_WEB_API_KEY alone is enough", async () => {
  const { provider } = await resolve({ WEB_PROVIDER: "deepseek", DEEPSEEK_WEB_API_KEY: "w" });
  assert.equal(provider?.name, "deepseek");
});

test("DEEPSEEK_ENABLED does not gate the web provider", async () => {
  const { provider } = await resolve({
    WEB_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "d",
    DEEPSEEK_ENABLED: "false",
  });
  assert.equal(provider?.name, "deepseek");
});

for (const [label, vars, expected] of [
  ["both set: the web key wins", { DEEPSEEK_WEB_API_KEY: "web-key", DEEPSEEK_API_KEY: "chat-key" }, "Bearer web-key"],
  ["blank web key falls back to the chat key", { DEEPSEEK_WEB_API_KEY: "  ", DEEPSEEK_API_KEY: "chat-key" }, "Bearer chat-key"],
] as const) {
  test(`key precedence: ${label}`, async () => {
    const { provider } = await resolve({ WEB_PROVIDER: "deepseek", ...vars });
    let authorization = "";
    (provider as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      authorization = (init?.headers as Record<string, string>).Authorization ?? "";
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;

    await provider?.search({ query: "q", limit: 1 });

    assert.equal(authorization, expected);
  });
}

test("WEB_PROVIDER=deepseek without any key yields no provider and warns", async () => {
  const { provider, warnings } = await resolve({
    WEB_PROVIDER: "deepseek",
    ANYCRAWL_API_KEY: "a",
  });
  assert.equal(provider, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /web_provider/);
});

test("WEB_PROVIDER=anycrawl without its key yields no provider, never DeepSeek", async () => {
  const { provider, warnings } = await resolve({
    WEB_PROVIDER: "anycrawl",
    DEEPSEEK_API_KEY: "d",
  });
  assert.equal(provider, null);
  assert.equal(warnings.length, 1);
});

test("an unknown WEB_PROVIDER fails configuration", async () => {
  const { input } = setup({ WEB_PROVIDER: "bing", ANYCRAWL_API_KEY: "a" });
  await assert.rejects(async () => createHostWebProvider(input), /WEB_PROVIDER/);
});

test("fetchTimeoutMs reaches the DeepSeek provider", async () => {
  const { input } = setup({ WEB_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "d" });
  const provider = await createHostWebProvider({ ...input, fetchTimeoutMs: 1234 });
  assert.equal(
    (provider as unknown as { fetchTimeoutMs: number }).fetchTimeoutMs,
    1234,
  );
});
