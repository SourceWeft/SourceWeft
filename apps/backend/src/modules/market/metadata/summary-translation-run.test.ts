import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

vi.mock("../../../shared/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../shared/model-gateway/system-client", () => ({
  getSystemModelReadiness: vi.fn(),
  withSystemModel: vi.fn(),
  SystemModelUnavailableError: class SystemModelUnavailableError extends Error {},
}));

import { SystemModelUnavailableError } from "../../../shared/model-gateway/system-client";
import {
  MCP_SUMMARY_TRANSLATION_PASS_LIMIT,
  runSummaryTranslationPass,
  type SummaryTranslationDeps,
} from "./summary-translation-run";
import { translatedRecord, type McpSummaryTranslation } from "./summary-translation";
import type { SummaryTranslationCandidate } from "./summary-translation-repository";

const NOW = new Date("2026-10-25T12:00:00Z");

function candidate(
  id: string,
  summary: string,
  over: Partial<SummaryTranslationCandidate> = {},
): SummaryTranslationCandidate {
  return { versionId: `v-${id}`, identifier: `io.github.acme/${id}`, summary, record: null, previous: null, ...over };
}

function harness(
  candidates: SummaryTranslationCandidate[],
  answer: (user: string) => unknown = () => ({ zhCN: "搜索页面。" }),
  ready = true,
) {
  const written: Array<[string, McpSummaryTranslation]> = [];
  const asked: string[] = [];
  const deps: SummaryTranslationDeps = {
    findCandidates: vi.fn(async () => candidates),
    write: vi.fn(async (versionId, record) => {
      written.push([versionId, record]);
    }),
    callModel: vi.fn(async (input) => {
      asked.push(input.user);
      const output = answer(input.user);
      if (output instanceof Error) throw output;
      return { output, model: "test-model" };
    }),
    modelReady: async () => ready,
    now: () => NOW,
  };
  return { deps, written, asked };
}

const ENGLISH = "Search and read pages in your Notion workspace.";

describe("a pass", () => {
  test("translates a candidate and stores both Chinese texts with the source hash", async () => {
    const { deps, written, asked } = harness([candidate("a", ENGLISH)]);
    const result = await runSummaryTranslationPass({}, deps);
    assert.equal(result.reports[0]?.outcome, "translated");
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /<description>/);
    const [versionId, record] = written[0]!;
    assert.equal(versionId, "v-a");
    assert.equal(record.status, "translated");
    assert.equal(record["zh-CN"], "搜索页面。");
    assert.equal(record["zh-TW"], "搜尋頁面。");
    assert.match(record.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(record.model, "test-model");
  });

  test("asks for at most the pass limit unless told otherwise", async () => {
    const { deps } = harness([]);
    await runSummaryTranslationPass({}, deps);
    assert.deepEqual(vi.mocked(deps.findCandidates).mock.calls[0]![0], {
      limit: MCP_SUMMARY_TRANSLATION_PASS_LIMIT,
      now: NOW,
    });
    await runSummaryTranslationPass({ limit: 3 }, deps);
    assert.equal(vi.mocked(deps.findCandidates).mock.calls[1]![0].limit, 3);
  });

  test("a Chinese description needs no translation: recorded, no model call", async () => {
    const { deps, written, asked } = harness([candidate("zh", "搜索并读取 Notion 工作区中的页面")]);
    const result = await runSummaryTranslationPass({}, deps);
    assert.equal(result.reports[0]?.outcome, "not-needed");
    assert.equal(asked.length, 0);
    assert.equal(written[0]![1].sourceLanguage, "zh");
  });

  test("federation's placeholder is not translated and not recorded", async () => {
    const { deps, written, asked } = harness([
      candidate("p", "MCP server io.github.acme/p from the MCP registry."),
    ]);
    const result = await runSummaryTranslationPass({}, deps);
    assert.equal(result.reports.length, 0);
    assert.equal(asked.length + written.length, 0);
  });

  test("an earlier version's current translation of the same text is reused without a model call", async () => {
    const previous = translatedRecord({ summary: ENGLISH, zhCN: "旧译文。", model: "old", now: new Date("2026-10-01T00:00:00Z") });
    const { deps, written, asked } = harness([candidate("a", ENGLISH, { previous })]);
    const result = await runSummaryTranslationPass({}, deps);
    assert.equal(result.reports[0]?.outcome, "reused");
    assert.equal(asked.length, 0);
    assert.equal(written[0]![1]["zh-CN"], "旧译文。");
  });

  test("a translation of different text in an earlier version is not reused", async () => {
    const previous = translatedRecord({ summary: "An older description of it.", zhCN: "旧译文。", model: "old", now: NOW });
    const { deps, asked } = harness([candidate("a", ENGLISH, { previous })]);
    const result = await runSummaryTranslationPass({}, deps);
    assert.equal(result.reports[0]?.outcome, "translated");
    assert.equal(asked.length, 1);
  });

  test("a current record is left alone (the refresh is on the English changing, not on a clock)", async () => {
    const record = translatedRecord({ summary: ENGLISH, zhCN: "译文。", model: "m", now: NOW });
    const { deps, written, asked } = harness([candidate("a", ENGLISH, { record })]);
    await runSummaryTranslationPass({}, deps);
    assert.equal(asked.length + written.length, 0);
  });

  test("a changed English text is translated again and replaces the record", async () => {
    const stale = translatedRecord({ summary: "Old text about pages.", zhCN: "旧译文。", model: "m", now: NOW });
    const { deps, written } = harness([candidate("a", ENGLISH, { record: stale })]);
    await runSummaryTranslationPass({}, deps);
    assert.equal(written[0]![1]["zh-CN"], "搜索页面。");
    assert.notEqual(written[0]![1].sourceHash, stale.sourceHash);
  });

  test("an answer that is not a Chinese translation is recorded as failed, and the pass goes on", async () => {
    const { deps, written } = harness(
      [candidate("bad", ENGLISH), candidate("good", "Another server that reads calendars.")],
      (user) => (user.includes("calendars") ? { zhCN: "读取日历。" } : { zhCN: "English only" }),
    );
    const result = await runSummaryTranslationPass({}, deps);
    assert.deepEqual(result.reports.map((r) => r.outcome), ["failed", "translated"]);
    assert.equal(written[0]![1].status, "failed");
    assert.equal(written[0]![1]["zh-CN"], undefined);
  });

  test("a model error records a failure; three in a row end the pass; an unready model ends it at once", async () => {
    const many = ["a", "b", "c", "d"].map((id) => candidate(id, `${ENGLISH} (${id})`));
    const flaky = harness(many, () => new Error("502"));
    const result = await runSummaryTranslationPass({}, flaky.deps);
    assert.deepEqual(result.reports.map((r) => r.outcome), ["failed", "failed"]);
    assert.equal(vi.mocked(flaky.deps.callModel).mock.calls.length, 3);

    const unavailable = harness(many, () => new SystemModelUnavailableError({} as never));
    const stopped = await runSummaryTranslationPass({}, unavailable.deps);
    assert.equal(stopped.reports.length, 0);
    assert.equal(vi.mocked(unavailable.deps.callModel).mock.calls.length, 1);
  });

  test("does nothing while the system model is not ready", async () => {
    const { deps, written } = harness([candidate("a", ENGLISH)], undefined, false);
    const result = await runSummaryTranslationPass({}, deps);
    assert.equal(result.skipped, true);
    assert.equal(written.length, 0);
    assert.equal(vi.mocked(deps.findCandidates).mock.calls.length, 0);
  });

  test("a dry run calls the model and reports, but stores nothing", async () => {
    const { deps, written, asked } = harness([candidate("a", ENGLISH)]);
    const result = await runSummaryTranslationPass({ dryRun: true }, deps);
    assert.equal(result.dryRun, true);
    assert.equal(asked.length, 1);
    assert.equal(written.length, 0);
    assert.equal(result.reports[0]?.record["zh-TW"], "搜尋頁面。");
    assert.equal(result.reports[0]?.summary, ENGLISH);
  });
});
