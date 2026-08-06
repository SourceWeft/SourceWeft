import assert from "node:assert/strict";
import { test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMcp: vi.fn(),
  countMcpByCategory: vi.fn(),
  findMcp: vi.fn(),
  findMcpVersion: vi.fn(),
  listCategories: vi.fn(),
}));

// The market service now reads the catalog in-process (sourceweft-api retired),
// so it delegates to the market read module rather than an HTTP MarketClient.
vi.mock("../market/read-repository", () => ({
  listMcp: mocks.listMcp,
  countMcpByCategory: mocks.countMcpByCategory,
  findMcp: mocks.findMcp,
  findMcpVersion: mocks.findMcpVersion,
}));

vi.mock("../market/read-categories", () => ({
  listMcpCategories: mocks.listCategories,
}));

vi.mock("../../shared/config", () => ({
  config: { market: { enabled: true } },
}));

vi.mock("../../shared/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { MarketService } from "./market-service";

test("listMcp delegates to the in-process read repository", async () => {
  mocks.listMcp.mockResolvedValue({
    items: [{ identifier: "io.github.acme/mcp" }],
    nextCursor: null,
  });

  const result = await new MarketService().listMcp({ query: "acme" });

  assert.deepEqual(result, {
    items: [{ identifier: "io.github.acme/mcp" }],
    nextCursor: null,
  });
  assert.deepEqual(mocks.listMcp.mock.calls[0]?.[0], { query: "acme" });
});

test("listMcp degrades to an empty catalog when the read throws", async () => {
  mocks.listMcp.mockRejectedValue(new Error("db unavailable"));

  const result = await new MarketService().listMcp({});

  assert.deepEqual(result, { items: [], nextCursor: null });
});

test("countMcpByCategory delegates to the read repository", async () => {
  mocks.countMcpByCategory.mockResolvedValue({
    counts: { "developer-tools": 12 },
    total: 20,
  });

  const result = await new MarketService().countMcpByCategory({ query: "git" });

  assert.deepEqual(result, { counts: { "developer-tools": 12 }, total: 20 });
  assert.deepEqual(mocks.countMcpByCategory.mock.calls[0]?.[0], {
    query: "git",
  });
});

test("countMcpByCategory surfaces non-DB read failures", async () => {
  // The repository itself degrades DB-unavailable to empty counts; anything it
  // rethrows is a real failure and must not masquerade as "no matching items".
  mocks.countMcpByCategory.mockRejectedValue(new Error("boom"));

  await assert.rejects(
    () => new MarketService().countMcpByCategory({}),
    /boom/,
  );
});

test("getMcpManifest maps the found version, 404s when missing", async () => {
  mocks.findMcpVersion.mockResolvedValue({
    record: { item: { identifier: "io.github.acme/mcp" } },
    itemVersion: { version: "1.2.0", manifestJson: { identifier: "x" } },
  });

  const found = await new MarketService().getMcpManifest("io.github.acme/mcp", {
    version: "1.2.0",
  });
  assert.equal(found.version.version, "1.2.0");
  assert.deepEqual(found.manifest, { identifier: "x" });

  mocks.findMcpVersion.mockResolvedValue(null);
  await assert.rejects(() =>
    new MarketService().getMcpManifest("io.github.acme/missing"),
  );
});
