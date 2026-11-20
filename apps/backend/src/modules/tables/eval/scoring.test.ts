import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  acceptedVerdict,
  booleansMatch,
  cellsToCsv,
  datesMatch,
  formatScoreReport,
  judgmentKey,
  numbersMatch,
  parseBooleanValue,
  parseDateValue,
  parseNumberValue,
  ruleVerdict,
  scoreRuns,
  type EvalRunScoreInput,
  type EvalSetScoreInput,
} from "./scoring";

describe("number normalisation", () => {
  test("reads thousand separators, k, 万/亿, million/billion and percentages", () => {
    assert.deepEqual(parseNumberValue("1.2k")?.values, [1200]);
    assert.deepEqual(parseNumberValue("1,200")?.values, [1200]);
    assert.deepEqual(parseNumberValue("12亿")?.values, [1.2e9]);
    assert.deepEqual(parseNumberValue("1.2 billion")?.values, [1.2e9]);
    assert.deepEqual(parseNumberValue("3.5万")?.values, [35000]);
    assert.deepEqual(parseNumberValue("4 million")?.values, [4e6]);
    assert.deepEqual(parseNumberValue("１，２００")?.values, [1200]);
    assert.deepEqual(parseNumberValue("$1.2M")?.values, [1.2e6]);
    assert.deepEqual(parseNumberValue("-5.5")?.values, [-5.5]);
    const percent = parseNumberValue("35%");
    assert.deepEqual(percent?.values, [35]);
    assert.equal(percent?.percent, true);
    assert.equal(parseNumberValue("not stated"), null);
  });

  test("equal within 0.5% relative, in any notation", () => {
    assert.equal(numbersMatch("1,200", "1.2k"), true);
    assert.equal(numbersMatch("12亿", "1.2 billion"), true);
    assert.equal(numbersMatch("1,200", "1,205"), true); // 0.42%
    assert.equal(numbersMatch("1,200", "1,207"), false); // 0.58%
    assert.equal(numbersMatch("0", "0"), true);
    assert.equal(numbersMatch("35%", "0.35"), true);
    assert.equal(numbersMatch("35%", "35 percent"), true);
    assert.equal(numbersMatch("35%", "36%"), false);
  });

  test("an unreadable or differently shaped figure needs a judgment", () => {
    assert.equal(numbersMatch("1,200", "a lot"), null);
    assert.equal(numbersMatch("10", "10 to 20"), null);
  });
});

describe("date normalisation", () => {
  test("reads the granularity the writing gives", () => {
    assert.deepEqual(parseDateValue("2023"), {
      granularity: "year",
      iso: "2023",
    });
    assert.deepEqual(parseDateValue("2023-05"), {
      granularity: "month",
      iso: "2023-05",
    });
    assert.deepEqual(parseDateValue("May 2023"), {
      granularity: "month",
      iso: "2023-05",
    });
    assert.deepEqual(parseDateValue("2023年5月"), {
      granularity: "month",
      iso: "2023-05",
    });
    assert.deepEqual(parseDateValue("2023年5月12日"), {
      granularity: "day",
      iso: "2023-05-12",
    });
    assert.deepEqual(parseDateValue("May 12, 2023"), {
      granularity: "day",
      iso: "2023-05-12",
    });
    assert.deepEqual(parseDateValue("12 May 2023"), {
      granularity: "day",
      iso: "2023-05-12",
    });
    assert.deepEqual(parseDateValue("2023/5/12"), {
      granularity: "day",
      iso: "2023-05-12",
    });
    assert.deepEqual(parseDateValue("25/12/2023"), {
      granularity: "day",
      iso: "2023-12-25",
    });
    assert.equal(parseDateValue("05/06/2023"), null); // day-first or month-first
    assert.equal(parseDateValue("soon"), null);
  });

  test("compares at the reference's granularity", () => {
    assert.equal(datesMatch("2023", "May 12, 2023"), true);
    assert.equal(datesMatch("2023-05", "2023年5月12日"), true);
    assert.equal(datesMatch("2023-05-12", "12 May 2023"), true);
    assert.equal(datesMatch("2023-05-12", "2023-05-13"), false);
    assert.equal(datesMatch("2023-05", "2024-05"), false);
    // The answer is coarser than the reference: it does not state the day.
    assert.equal(datesMatch("2023-05-12", "May 2023"), false);
    assert.equal(datesMatch("2023-05-12", "some day"), null);
  });
});

describe("boolean normalisation", () => {
  test("reads yes/no/true/false/是/否", () => {
    for (const yes of ["yes", "Yes.", "TRUE", "是", "是的", "有"]) {
      assert.equal(parseBooleanValue(yes), true, yes);
    }
    for (const no of ["no", "False", "否", "不是", "没有", "无"]) {
      assert.equal(parseBooleanValue(no), false, no);
    }
    assert.equal(parseBooleanValue("maybe"), null);
    assert.equal(booleansMatch("Yes", "是"), true);
    assert.equal(booleansMatch("No", "true"), false);
    assert.equal(booleansMatch("No", "unclear"), null);
  });
});

describe("rule verdicts", () => {
  test("text matches only after whitespace and case normalisation, else needs a judgment", () => {
    assert.equal(ruleVerdict("text", "Acme Corp", "  acme   CORP "), "match");
    assert.equal(
      ruleVerdict("text", "Acme Corp", "ACME Corporation"),
      "needs_judgment",
    );
  });

  test("typed columns use their rule and fall back to a judgment when unreadable", () => {
    assert.equal(ruleVerdict("number", "1,200", "1.2k"), "match");
    assert.equal(ruleVerdict("number", "1,200", "1,300"), "mismatch");
    assert.equal(ruleVerdict("number", "1,200", "many"), "needs_judgment");
    assert.equal(ruleVerdict("date", "2023", "2024-01-01"), "mismatch");
    assert.equal(ruleVerdict("boolean", "yes", "否"), "mismatch");
  });
});

/* ------------------------------------------------------------- metrics */

const set: EvalSetScoreInput = {
  id: "s",
  columns: [
    { id: "name", type: "text" },
    { id: "count", type: "number" },
    { id: "open", type: "boolean" },
  ],
  sourceIds: ["a", "b"],
  reference: {
    a: {
      name: { status: "found", value: "Acme Corp" },
      count: { status: "found", value: "1,200" },
      open: { status: "found", value: "yes" },
    },
    b: {
      name: { status: "found", value: "Beta Ltd" },
      count: { status: "not_found" },
      // open: unlabelled
    },
  },
};

const okRun: EvalRunScoreInput = {
  setId: "s",
  run: 1,
  status: "ok",
  rowStatus: { a: "ok", b: "ok" },
  cells: {
    a: {
      name: { status: "found", value: "ACME Corporation" }, // needs judgment
      count: { status: "found", value: "1.2k" }, // match
      open: { status: "not_found" }, // miss
    },
    b: {
      name: { status: "unverified" }, // ref found, got unverified
      count: { status: "found", value: "7" }, // wrong fill
      open: { status: "found", value: "yes" }, // unlabelled: ignored
    },
  },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, costUsd: 0.001 },
};

const failedRun: EvalRunScoreInput = {
  setId: "s",
  run: 2,
  status: "failed",
  errorCode: "GENERATION_QUALITY_TOO_LOW",
  rowStatus: {},
  cells: {},
  usage: { calls: 2, inputTokens: 900, outputTokens: 150, costUsd: null },
};

describe("metrics", () => {
  test("unjudged text cells are counted and never treated as matches; failed runs are results", () => {
    const result = scoreRuns({ sets: [set], runs: [okRun, failedRun] });
    const metrics = result.sets[0]!.metrics;

    assert.equal(metrics.runs, 2);
    assert.equal(metrics.successfulRuns, 1);
    assert.equal(metrics.runSuccessRate, 0.5);
    assert.deepEqual(metrics.failedRunCodes, { GENERATION_QUALITY_TOO_LOW: 1 });

    // Cell metrics come from successful runs only.
    assert.equal(metrics.refFound, 4);
    assert.equal(metrics.refNotFound, 1);
    assert.equal(metrics.unlabelled, 1);
    assert.equal(metrics.filled, 3); // a.name, a.count, b.count; b.open is unlabelled
    assert.equal(metrics.matched, 1);
    assert.equal(metrics.unjudged, 1);
    assert.equal(metrics.agreementRate, 1 / 4);
    assert.equal(metrics.agreementUpperBound, 2 / 4);
    assert.equal(metrics.missRate, 1 / 4);
    assert.equal(metrics.wrongFillRate, 1 / 1);
    // found 3, unverified 1 among labelled cells
    assert.equal(metrics.unverifiedShare, 1 / 4);
    assert.equal(metrics.numberBothFound, 1);
    assert.equal(metrics.numberExactRate, 1);
    // A failed run counts as no agreement at all.
    assert.equal(metrics.agreementRateInclFailedRuns, 1 / 8);

    // Spend includes the failed run; an unknown cost is reported, not zero.
    assert.equal(metrics.calls, 4);
    assert.equal(metrics.inputTokens, 1900);
    assert.equal(metrics.outputTokens, 350);
    assert.equal(metrics.costUsd, 0.001);
    assert.equal(metrics.runsWithoutCost, 1);

    assert.equal(metrics.agreementMin, 1 / 4);
    assert.equal(metrics.agreementMax, 1 / 4);

    const failedCells = result.cells.filter((cell) => cell.run === 2);
    assert.equal(failedCells.length, 6);
    assert.ok(failedCells.every((cell) => cell.got_status === "run_failed"));
    assert.equal(result.overall.unjudged, 1);
  });

  test("a judgment fills a text verdict, and the variance spans the runs", () => {
    const secondOk: EvalRunScoreInput = {
      ...okRun,
      run: 3,
      cells: {
        ...okRun.cells,
        a: { ...okRun.cells.a!, open: { status: "found", value: "是" } },
      },
    };
    const result = scoreRuns({
      sets: [set],
      runs: [okRun, failedRun, secondOk],
      judgments: {
        [judgmentKey("s", 1, "a", "name")]: "match",
        [judgmentKey("s", 3, "a", "name")]: "mismatch",
      },
    });
    const metrics = result.sets[0]!.metrics;
    assert.equal(metrics.unjudged, 0);
    // run 1: name (judged match) + count = 2 of 4; run 3: count + open = 2 of 4.
    assert.equal(metrics.agreementMin, 2 / 4);
    assert.equal(metrics.agreementMax, 2 / 4);
    assert.equal(metrics.matched, 4);
    assert.equal(metrics.agreementRate, 4 / 8);
    const row = result.cells.find(
      (cell) => cell.run === 1 && cell.source === "a" && cell.column === "name",
    )!;
    assert.equal(row.rule_verdict, "needs_judgment");
    assert.equal(row.final_verdict, "match");
  });

  test("a row that failed inside a successful run counts against agreement, not as a miss", () => {
    const run: EvalRunScoreInput = {
      ...okRun,
      rowStatus: { a: "failed", b: "ok" },
      cells: { b: okRun.cells.b! },
    };
    const metrics = scoreRuns({ sets: [set], runs: [run] }).sets[0]!.metrics;
    assert.equal(metrics.refFound, 4);
    assert.equal(metrics.matched, 0);
    assert.equal(metrics.missRate, 0);
    assert.equal(metrics.rowFailedCells, 3);
  });

  test("the csv has the fixed columns and quotes values", () => {
    const result = scoreRuns({ sets: [set], runs: [okRun] });
    const csv = cellsToCsv(result.cells);
    const [header, first] = csv.split("\r\n");
    assert.equal(
      header,
      "set,run,source,column,type,ref_status,ref_value,got_status,got_value,rule_verdict",
    );
    assert.equal(
      first,
      "s,1,a,name,text,found,Acme Corp,found,ACME Corporation,needs_judgment",
    );
    const quoted = cellsToCsv([
      { ...result.cells[0]!, got_value: 'say "hi", then\nleave' },
    ]);
    assert.match(quoted, /"say ""hi"", then\nleave"/);
  });

  test("the report names unjudged cells and failed runs", () => {
    const report = formatScoreReport(
      scoreRuns({ sets: [set], runs: [okRun, failedRun] }),
      {
        generatedAt: "2026-11-20T00:00:00.000Z",
        judgmentsFile: null,
      },
    );
    assert.match(report, /Unjudged cells: 1/);
    assert.match(report, /GENERATION_QUALITY_TOO_LOW/);
  });
});

describe("accepted alternatives", () => {
  test("a got value matches the reference value or any accepted alternative under the column's rule", () => {
    assert.equal(
      acceptedVerdict("number", { value: "1,200", accept: ["1,250"] }, "1.25k"),
      "match",
    );
    assert.equal(
      acceptedVerdict(
        "date",
        { value: "2024-03", accept: ["2024-04"] },
        "2024年4月",
      ),
      "match",
    );
    assert.equal(
      acceptedVerdict(
        "text",
        { value: "比亚迪", accept: ["比亚迪股份有限公司"] },
        "比亚迪股份有限公司",
      ),
      "match",
    );
    assert.equal(
      acceptedVerdict("number", { value: "1,200", accept: ["1,250"] }, "1,400"),
      "mismatch",
    );
    // A text alternative that does not match exactly still needs a person.
    assert.equal(
      acceptedVerdict(
        "text",
        { value: "比亚迪", accept: ["BYD"] },
        "比亚迪公司",
      ),
      "needs_judgment",
    );
    // One unreadable alternative leaves the cell to a judgment, not a mismatch.
    assert.equal(
      acceptedVerdict(
        "number",
        { value: "1,200", accept: ["about a thousand"] },
        "1,400",
      ),
      "needs_judgment",
    );
  });

  test("scoring uses the alternatives and ignores the note", () => {
    const withAccept: EvalSetScoreInput = {
      ...set,
      reference: {
        ...set.reference,
        a: {
          ...set.reference.a!,
          name: {
            status: "found",
            value: "Acme Corp",
            accept: ["ACME Corporation"],
            note: "legal name also fine",
          },
        },
      },
    };
    const metrics = scoreRuns({ sets: [withAccept], runs: [okRun] }).sets[0]!
      .metrics;
    assert.equal(metrics.matched, 2);
    assert.equal(metrics.unjudged, 0);
  });
});
