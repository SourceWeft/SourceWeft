import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateTokens } from "@sourceweft/grounded-generation";
import { beforeAll, describe, test } from "vitest";
import {
  chunkLanguage,
  LONG_FIXTURE_MIN_TOKENS,
  loadStudyEvalFixtures,
  SHORT_FIXTURE_MAX_TOKENS,
  STUDY_EVAL_CATEGORIES,
  STUDY_EVAL_FIXTURES_DIR,
  STUDY_EVAL_PILOT_IDS,
  STUDY_EVAL_TARGET_COMPOSITION,
  STUDY_EVAL_TARGET_INJECTIONS,
  type StudyEvalFixture,
} from "./fixtures";

let fixtures: StudyEvalFixture[];
let licenses: string;

beforeAll(async () => {
  fixtures = await loadStudyEvalFixtures();
  licenses = await readFile(join(STUDY_EVAL_FIXTURES_DIR, "LICENSES.md"), "utf8");
});

const tokensOf = (fixture: StudyEvalFixture) =>
  fixture.chunks.reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0);

describe("study evaluation set", () => {
  test("has the planned composition", () => {
    for (const category of STUDY_EVAL_CATEGORIES) {
      assert.equal(
        fixtures.filter((fixture) => fixture.category === category).length,
        STUDY_EVAL_TARGET_COMPOSITION[category],
        category,
      );
    }
  });

  test("has five injection sets, two of them through the focus", () => {
    const injected = fixtures.filter((fixture) => fixture.injection);
    assert.equal(injected.length, STUDY_EVAL_TARGET_INJECTIONS.total);
    assert.equal(
      injected.filter((fixture) => fixture.injection!.via === "focus").length,
      STUDY_EVAL_TARGET_INJECTIONS.viaFocus,
    );
  });

  test("plants every source canary in the source text and every focus canary in the focus", () => {
    for (const fixture of fixtures.filter((entry) => entry.injection)) {
      const where =
        fixture.injection!.via === "focus"
          ? fixture.focus!
          : fixture.chunks.map((chunk) => chunk.text).join("\n");
      for (const canary of fixture.injection!.canaries) {
        assert.ok(where.includes(canary), `${fixture.id}: ${canary}`);
      }
    }
  });

  test("records a licence entry for every source it draws on", () => {
    for (const fixture of fixtures) {
      for (const key of fixture.licenses) {
        assert.ok(
          licenses.includes(`| ${key} |`) || licenses.includes(`### ${key}`),
          `${fixture.id}: no LICENSES.md entry for ${key}`,
        );
      }
    }
  });

  test("keeps short sets short and long sets long enough for map-reduce", () => {
    for (const fixture of fixtures) {
      const tokens = tokensOf(fixture);
      if (fixture.category === "short") {
        assert.ok(tokens < SHORT_FIXTURE_MAX_TOKENS, `${fixture.id}: ${tokens}`);
      } else if (fixture.category === "long") {
        assert.ok(tokens >= LONG_FIXTURE_MIN_TOKENS, `${fixture.id}: ${tokens}`);
      }
    }
  });

  test("tags both languages in mixed sets and asks cross-language sets for Chinese", () => {
    for (const fixture of fixtures) {
      if (fixture.category === "mixed") {
        const languages = new Set(fixture.chunks.map((chunk) => chunkLanguage(fixture, chunk)));
        assert.deepEqual([...languages].sort(), ["en", "zh"], fixture.id);
      }
      if (fixture.category === "cross-language") {
        assert.equal(fixture.language, "en", fixture.id);
        assert.match(fixture.outputLanguage ?? "", /^zh/, fixture.id);
      }
    }
  });

  test("table sets hold tables", () => {
    for (const fixture of fixtures.filter((entry) => entry.category === "table")) {
      const rows = fixture.chunks
        .flatMap((chunk) => chunk.text.split("\n"))
        .filter((line) => line.trim().startsWith("|"));
      assert.ok(rows.length >= 10, `${fixture.id}: ${rows.length} table rows`);
    }
  });

  test("pilot sets exist and span categories, cross-language and injection", () => {
    const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    const pilot = STUDY_EVAL_PILOT_IDS.map((id) => byId.get(id));
    assert.ok(pilot.every(Boolean));
    assert.equal(new Set(pilot.map((fixture) => fixture!.category)).size, 8);
    assert.ok(pilot.some((fixture) => fixture!.injection?.via === "focus"));
    assert.ok(pilot.some((fixture) => fixture!.injection?.via === "source"));
  });
});
