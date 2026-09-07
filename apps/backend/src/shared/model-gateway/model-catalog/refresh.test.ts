import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { ModelCatalogRegistry } from "./registry";
import { loadLiteLLMModels } from "./sources/litellm";
import { loadModelsDevModels } from "./sources/models-dev";
import { loadModelOverrides } from "./sources/overrides";
import { emptyModelInfo } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test.each(["litellm", "modelsDev", "overrides"] as const)(
  "%s failure retains every part of the previous registry",
  async (failing) => {
    let fail = false;
    let version = "original";
    const registry = new ModelCatalogRegistry({
      litellm: async () => {
        if (fail && failing === "litellm")
          throw new Error("litellm unavailable");
        return [
          {
            ...emptyModelInfo(version),
            provider: "provider",
            pricing: { inputPerToken: version === "original" ? 1 : 2 },
          },
        ];
      },
      modelsDev: async () => {
        if (fail && failing === "modelsDev")
          throw new Error("models.dev unavailable");
        return [{ ...emptyModelInfo(version), reasoning: true }];
      },
      overrides: () => {
        if (fail && failing === "overrides")
          throw new Error("overrides invalid");
        return new Map([[version, { vision: true }]]);
      },
    });
    await registry.refresh();
    const before = registry.resolve("original", { provider: "provider" });
    version = "replacement";
    fail = true;
    await assert.rejects(registry.refresh(), /unavailable|invalid/);
    assert.equal(registry.isReady(), true);
    assert.deepEqual(
      registry.resolve("original", { provider: "provider" }),
      before,
    );
    assert.equal(registry.resolve("replacement"), null);
    fail = false;
    await registry.refresh();
    assert.equal(registry.resolve("original"), null);
    assert.equal(registry.resolve("replacement")?.vision, true);
  },
);

test("first load failure remains unready; a valid empty response can replace a prior snapshot", async () => {
  let mode: "fail" | "full" | "empty" = "fail";
  const registry = new ModelCatalogRegistry({
    litellm: async () => {
      if (mode === "fail") throw new Error("offline");
      return mode === "full" ? [emptyModelInfo("model")] : [];
    },
    modelsDev: async () => [],
    overrides: () => new Map(),
  });
  await assert.rejects(registry.ensureReady(), /offline/);
  assert.equal(registry.isReady(), false);
  mode = "full";
  await registry.ensureReady();
  assert.ok(registry.resolve("model"));
  mode = "empty";
  await registry.refresh();
  assert.equal(registry.isReady(), true);
  assert.equal(registry.resolve("model"), null);
});

test("background refresh does not initiate unused catalog dependencies", async () => {
  vi.useFakeTimers();
  const source = vi.fn(async () => []);
  const registry = new ModelCatalogRegistry({
    litellm: source,
    modelsDev: source,
    overrides: () => new Map(),
  });
  registry.startAutoRefresh(100);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(source.mock.calls.length, 0);
  await registry.ensureReady();
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(source.mock.calls.length, 4);
  vi.clearAllTimers();
});

for (const [name, load] of [
  ["LiteLLM", loadLiteLLMModels],
  ["models.dev", loadModelsDevModels],
] as const) {
  test(`${name} distinguishes valid emptiness, transport failure and malformed data`, async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(Response.json({}));
    assert.deepEqual(await load(), []);
    fetch.mockRejectedValueOnce(new Error("network unavailable"));
    await assert.rejects(load(), /network unavailable/);
    fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await assert.rejects(load(), /Failed to fetch/);
    for (const payload of [[], null, "invalid", { entry: null }]) {
      fetch.mockResolvedValueOnce(Response.json(payload));
      await assert.rejects(load());
    }
    fetch.mockResolvedValueOnce(new Response("{broken"));
    await assert.rejects(load());
  });
}

test("an invalid configured override fails without echoing pasted contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourceweft-overrides-"));
  const path = join(directory, "overrides.json");
  vi.stubEnv("MODEL_OVERRIDES_PATH", path);
  try {
    assert.throws(loadModelOverrides, /MODEL_OVERRIDES_PATH/);
    await writeFile(path, '{"pasted-secret": broken}');
    assert.throws(loadModelOverrides, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("pasted-secret"), false);
      return true;
    });
    await writeFile(path, JSON.stringify({ local: { reasoning: true } }));
    assert.equal(loadModelOverrides().get("local")?.reasoning, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
