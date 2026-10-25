import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

vi.mock("../../shared/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../../shared/model-gateway/system-client", () => ({
  getSystemModelReadiness: vi.fn(),
  resolveSystemModelIdentity: vi.fn(),
  withSystemModel: vi.fn(),
  SystemModelUnavailableError: class extends Error {},
}));

import { processMcpSummaryTranslationJob } from "./mcp-summary-translation";
import type { SummaryTranslationDeps } from "../../modules/market/metadata/summary-translation-run";

const NOW = new Date("2026-10-25T12:00:00Z");

function deps(ready: boolean): SummaryTranslationDeps {
  return {
    findCandidates: vi.fn(async () => [
      {
        versionId: "v-1",
        identifier: "io.github.acme/one",
        summary: "Search and read the pages of your workspace.",
        record: null,
        previous: null,
      },
    ]),
    write: vi.fn(async () => undefined),
    callModel: vi.fn(async () => ({ output: { zhCN: "搜索页面。" }, model: "m" })),
    modelReady: async () => ready,
    now: () => NOW,
  };
}

describe("the translation job", () => {
  test("runs a pass and reports its outcomes", async () => {
    const d = deps(true);
    assert.deepEqual(await processMcpSummaryTranslationJob(d), {
      skipped: false,
      outcomes: { translated: 1 },
    });
    assert.equal(vi.mocked(d.write).mock.calls.length, 1);
  });

  test("does nothing while the system model is not ready", async () => {
    const d = deps(false);
    assert.deepEqual(await processMcpSummaryTranslationJob(d), { skipped: true, outcomes: {} });
    assert.equal(vi.mocked(d.findCandidates).mock.calls.length, 0);
  });
});
