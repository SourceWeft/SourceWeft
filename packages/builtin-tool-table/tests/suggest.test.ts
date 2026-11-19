import assert from "node:assert/strict";
import test from "node:test";
import { TABLE_LIMITS } from "@sourceweft/contracts/table";
import { SUGGEST_SUMMARY_CHARS } from "../src/engine/constants";
import { suggestColumns } from "../src/engine/suggest";
import { stubModel } from "./helpers";

const base = {
  referenceId: "user:1",
  idempotencyKey: "suggest-1",
  language: "en",
  sources: [
    { title: "Atlas report", summary: "A trial of 1,200 adults." },
    { title: "Beacon study", summary: "A cohort." },
  ],
};

const column = (name: string, type = "text", description: string | null = "d") => ({
  name,
  description,
  type,
});

test("suggestColumns keeps at most 8 columns, drops duplicate names, and bills one suggest call", async () => {
  const names = ["Design", "Sample size", "design", "Funding", "Country", "Outcome", "Follow up", "Risk", "Bias", "Licence"];
  const { model, calls } = stubModel(() => ({
    columns: names.map((name) => column(name)),
  }));
  const columns = await suggestColumns({ model }, base);
  assert.deepEqual(
    columns.map((c) => c.name),
    ["Design", "Sample size", "Funding", "Country", "Outcome", "Follow up", "Risk", "Bias"],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.operation, "table.columns.suggest");
  assert.equal(calls[0]!.idempotencyKey, "suggest-1");
  assert.equal(calls[0]!.referenceId, "user:1");
  assert.equal(calls[0]!.maxTokens, 800);
});

test("names are deduplicated after normalisation, not by exact text", async () => {
  const { model } = stubModel(() => ({
    columns: [column("Sample size"), column("sample  SIZE!"), column("Sample-size")],
  }));
  const columns = await suggestColumns({ model }, base);
  assert.deepEqual(columns.map((c) => c.name), ["Sample size"]);
});

test("over-long names and descriptions are cut to the limits and never carry ids", async () => {
  const { model } = stubModel(() => ({
    columns: [
      column("N".repeat(200), "text", "D".repeat(500)),
      column("Short", "number", null),
    ],
  }));
  const [first, second] = await suggestColumns({ model }, base);
  assert.equal(first!.name.length, TABLE_LIMITS.columnNameChars);
  assert.equal(first!.description!.length, TABLE_LIMITS.columnDescriptionChars);
  assert.equal(second!.description, undefined);
  assert.equal("id" in first!, false);
  assert.deepEqual(second!.type, "number");
});

test("entries without a usable name or type are dropped", async () => {
  const { model } = stubModel(() => ({
    columns: [
      column("  "),
      column("!!!"),
      column("Bad type", "image"),
      { description: "no name", type: "text" },
      "nonsense",
      column("Good"),
    ],
  }));
  assert.deepEqual((await suggestColumns({ model }, base)).map((c) => c.name), ["Good"]);
});

test("an answer with no usable column is a quality failure, not an empty list", async () => {
  const { model } = stubModel(() => ({ columns: [] }));
  await assert.rejects(
    suggestColumns({ model }, base),
    (error: { code?: string }) => error.code === "GENERATION_QUALITY_TOO_LOW",
  );
  const malformed = stubModel(() => ({ nope: true }));
  await assert.rejects(
    suggestColumns({ model: malformed.model }, base),
    (error: { code?: string }) => error.code === "GENERATION_QUALITY_TOO_LOW",
  );
});

test("never places source text or the instruction in the system turn, and wraps them as data", async () => {
  const { model, calls } = stubModel(() => ({ columns: [column("A")] }));
  await suggestColumns(
    { model },
    { ...base, instruction: "INSTRUCTION-MARKER: compare funding" },
  );
  const call = calls[0]!;
  for (const marker of ["INSTRUCTION-MARKER", "Atlas report", "A trial of 1,200 adults."]) {
    assert.ok(!call.system.includes(marker));
    assert.ok(call.user.includes(marker));
  }
  assert.match(call.user, /<<<SOURCE 1/);
  assert.match(call.user, /<<<INSTRUCTION>>>/);
});

test("each summary is cut to the summary limit before it reaches the model", async () => {
  const { model, calls } = stubModel(() => ({ columns: [column("A")] }));
  await suggestColumns(
    { model },
    { ...base, sources: [{ title: "T", summary: "s".repeat(SUGGEST_SUMMARY_CHARS + 500) }] },
  );
  assert.equal(calls[0]!.user.match(/s{10,}/)![0]!.length, SUGGEST_SUMMARY_CHARS);
});

test("a model failure propagates unchanged", async () => {
  const boom = new Error("model exploded");
  const { model } = stubModel(() => {
    throw boom;
  });
  await assert.rejects(suggestColumns({ model }, base), boom);
});
