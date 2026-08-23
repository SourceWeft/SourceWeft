import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ThreadModelSelectorCatalog } from "./model-catalog-loader";
import {
  loadThreadModelSelectorCatalog,
  resetThreadModelSelectorCatalogCacheForTests,
} from "./model-catalog-loader";

function catalog(label: string): ThreadModelSelectorCatalog {
  return {
    defaults: {
      llmProfileAlias: label,
      imageProfileAlias: null,
      visionProfileAlias: null,
      llmModelAlias: label,
      imageModelAlias: null,
      visionModelAlias: null,
    },
    kinds: { llm: [], image: [], vision: [] },
  };
}

beforeEach(() => {
  resetThreadModelSelectorCatalogCacheForTests();
});

test("concurrent workspace loads share one in-flight request", async () => {
  let resolveCatalog!: (value: ThreadModelSelectorCatalog) => void;
  const pending = new Promise<ThreadModelSelectorCatalog>((resolve) => {
    resolveCatalog = resolve;
  });
  const load = vi.fn(() => pending);

  const first = loadThreadModelSelectorCatalog("workspace-1", { load });
  const second = loadThreadModelSelectorCatalog("workspace-1", { load });
  resolveCatalog(catalog("chat-default"));

  assert.equal(await first, await second);
  assert.equal(load.mock.calls.length, 1);
});

test("successful catalogs are reused for 60 seconds and expire afterward", async () => {
  let currentTime = 1_000;
  const load = vi
    .fn<(workspaceId: string) => Promise<ThreadModelSelectorCatalog>>()
    .mockResolvedValueOnce(catalog("first"))
    .mockResolvedValueOnce(catalog("second"));
  const options = { load, now: () => currentTime };

  assert.equal(
    (await loadThreadModelSelectorCatalog("workspace-1", options)).defaults
      .llmProfileAlias,
    "first",
  );
  currentTime += 59_999;
  assert.equal(
    (await loadThreadModelSelectorCatalog("workspace-1", options)).defaults
      .llmProfileAlias,
    "first",
  );
  currentTime += 2;
  assert.equal(
    (await loadThreadModelSelectorCatalog("workspace-1", options)).defaults
      .llmProfileAlias,
    "second",
  );
  assert.equal(load.mock.calls.length, 2);
});

test("failed catalog loads are evicted and retryable", async () => {
  const load = vi
    .fn<(workspaceId: string) => Promise<ThreadModelSelectorCatalog>>()
    .mockRejectedValueOnce(new Error("temporary"))
    .mockResolvedValueOnce(catalog("recovered"));

  await assert.rejects(
    loadThreadModelSelectorCatalog("workspace-1", { load }),
    /temporary/,
  );
  const recovered = await loadThreadModelSelectorCatalog("workspace-1", {
    load,
  });

  assert.equal(recovered.defaults.llmProfileAlias, "recovered");
  assert.equal(load.mock.calls.length, 2);
});

test("catalog values never cross workspace keys", async () => {
  const load = vi.fn(async (workspaceId: string) => catalog(workspaceId));

  const first = await loadThreadModelSelectorCatalog("workspace-1", { load });
  const second = await loadThreadModelSelectorCatalog("workspace-2", { load });

  assert.equal(first.defaults.llmProfileAlias, "workspace-1");
  assert.equal(second.defaults.llmProfileAlias, "workspace-2");
  assert.equal(load.mock.calls.length, 2);
});
