import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/**
 * #516: the report reads only the stored decision numbers and the existing
 * LLM observability rows; the export recomputes claim and passage from the
 * message and chunk and writes only borderline cases, only to ignored paths.
 */
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let report: typeof import("./anchoring-report");
let calibration: typeof import("./anchoring-calibration");
const originalDatabaseUrl = process.env.DATABASE_URL;
const repoRoot = resolve(import.meta.dirname, "../../../../..");
const scratch = resolve(repoRoot, ".local-eval", `test-${randomUUID()}`);

const NOW = new Date("2026-11-15T12:00:00Z");
const day = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);

const teamId = randomUUID();
const workspaceId = randomUUID();
const threadId = randomUUID();
const messageIds = Array.from({ length: 7 }, () => randomUUID());
const messageId = messageIds[0]!;
const chunkId = randomUUID();
const PASSAGE = "Revenue grew 23% to $4.1 billion in fiscal 2025.";
const ANSWER =
  "营收增长23%，达到41亿美元 [citation:c1]。公司在新加坡开设了新办公室 [citation:c2]。";

function anchoring(
  scripts: string,
  semantic?: {
    similarity: number | null;
    margin: number | null;
    outcome: string;
  },
) {
  return {
    method: semantic ? "semantic" : "lexical",
    scripts,
    lexicalScore: 0.1,
    ...(semantic ? { semantic: { ...semantic, segments: 3 } } : {}),
  };
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("anchoring_report");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  report = await import("./anchoring-report");
  calibration = await import("./anchoring-calibration");
  const { db } = schema;
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Anchoring report",
    slug: `anchoring-report-${workspaceId}`,
  });
  await db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Report",
    createdBy: "report-user",
  });
  // A citation key is unique per message, so each record gets its own answer.
  await db.insert(schema.messages).values(
    messageIds.map((id) => ({
      id,
      teamId,
      workspaceId,
      threadId,
      role: "assistant" as const,
      content: ANSWER,
    })),
  );
  const sourceId = randomUUID();
  const documentId = randomUUID();
  await db.insert(schema.sources).values({
    id: sourceId,
    teamId,
    workspaceId,
    title: "Report",
    status: "indexed",
  });
  await db.insert(schema.documents).values({
    id: documentId,
    teamId,
    workspaceId,
    sourceId,
    contentText: PASSAGE,
    status: "ready",
  });
  await db.insert(schema.chunks).values({
    id: chunkId,
    teamId,
    workspaceId,
    sourceId,
    documentId,
    chunkNo: 0,
    content: PASSAGE,
  });

  const citation = (
    key: string,
    support: string,
    anchor: unknown,
    createdAt: Date,
    rank: number,
  ) => ({
    id: `${key}-${randomUUID()}`,
    teamId,
    workspaceId,
    threadId,
    messageId: messageIds[rank - 1]!,
    chunkId,
    citationKey: key,
    rank,
    createdAt,
    metadataJson: { support, anchoring: anchor },
  });
  await db.insert(schema.citations).values([
    // Near the similarity threshold, judged strong.
    citation(
      "c1",
      "strong",
      anchoring("cjk>latin", {
        similarity: 0.72,
        margin: 0.4,
        outcome: "strong",
      }),
      day(1),
      1,
    ),
    // Near the margin threshold, refused.
    citation(
      "c2",
      "weak",
      anchoring("cjk>latin", {
        similarity: 0.3,
        margin: 0.12,
        outcome: "below_similarity",
      }),
      day(1),
      2,
    ),
    // Far from both thresholds: not borderline.
    citation(
      "c1",
      "strong",
      anchoring("latin>cjk", {
        similarity: 0.95,
        margin: 0.6,
        outcome: "strong",
      }),
      day(2),
      3,
    ),
    // Same language, word matcher only.
    citation("c1", "strong", anchoring("same"), day(2), 4),
    // Too old for a 7-day report.
    citation(
      "c2",
      "weak",
      anchoring("cjk>latin", {
        similarity: 0.7,
        margin: 0.15,
        outcome: "strong",
      }),
      day(30),
      5,
    ),
    // Over budget: nothing was compared.
    citation(
      "c2",
      "weak",
      anchoring("cjk>latin", {
        similarity: null,
        margin: null,
        outcome: "over_budget",
      }),
      day(1),
      6,
    ),
    // A citation stored before decision records existed.
    {
      ...citation("c1", "strong", null, day(1), 7),
      metadataJson: { support: "strong" },
    },
  ]);

  const generation = (
    latencyMs: number,
    status: string,
    traceId: string,
    startedAt: Date,
  ) => ({
    id: randomUUID(),
    traceId,
    spanId: randomUUID(),
    teamId,
    workspaceId,
    operation: "embeddings.embedBatch",
    status: status as "ok" | "error",
    latencyMs,
    startedAt,
  });
  const ours = `${messageId}:citation-anchoring`;
  await db.insert(schema.llmGenerations).values([
    generation(100, "ok", ours, day(1)),
    generation(200, "ok", `${randomUUID()}:citation-anchoring`, day(1)),
    generation(300, "ok", `${randomUUID()}:citation-anchoring`, day(2)),
    generation(50, "error", `${randomUUID()}:citation-anchoring`, day(2)),
    // Other embedding features and old calls do not count.
    generation(9999, "ok", `${randomUUID()}:source-indexing`, day(1)),
    generation(9999, "ok", `${randomUUID()}:citation-anchoring`, day(40)),
  ]);
}, 120_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("the report counts decisions by method, script pair and outcome from the stored numbers", async () => {
  const result = await report.loadAnchoringReport({ days: 7, now: NOW });
  const total = result.decisions.reduce((sum, row) => sum + row.count, 0);
  // Five records inside the window; the 30-day-old one and the pre-record one are out.
  assert.equal(total, 5);
  const by = (outcome: string | null) =>
    result.decisions
      .filter((row) => row.outcome === outcome)
      .reduce((sum, row) => sum + row.count, 0);
  assert.equal(by("strong"), 2);
  assert.equal(by("below_similarity"), 1);
  assert.equal(by("over_budget"), 1);
  assert.equal(by(null), 1);
  const near = (key: "nearSimilarity" | "nearMargin") =>
    result.decisions.reduce((sum, row) => sum + row[key], 0);
  assert.equal(near("nearSimilarity"), 1);
  assert.equal(near("nearMargin"), 1);

  const text = report.formatAnchoringReport(result);
  expect(text).toContain("Citations with a decision record: 5");
  expect(text).toContain("cjk>latin");
  expect(text).toContain("below_similarity");
  expect(text).toContain("over budget 1");
  // Nothing of the conversation reaches the report.
  expect(text).not.toContain("营收");
  expect(text).not.toContain("Revenue");
});

test("embedding latency and failures come from the observability rows of the second pass only", async () => {
  const { embedding } = await report.loadAnchoringReport({ days: 7, now: NOW });
  assert.equal(embedding.calls, 4);
  assert.equal(embedding.failed, 1);
  assert.equal(embedding.p50Ms, 200);
  assert.equal(embedding.p95Ms, 290);
});

test("the export holds only borderline cases, recomputed from the message and chunk", async () => {
  const { cases } = await calibration.findBorderlineCases({
    limit: 10,
    now: NOW,
  });
  // c1 (0.72) and c2 (margin 0.12) are near a threshold; the 0.95 case, the
  // word-matched one and the one with nothing compared are not. The 30-day-old
  // case at exactly the thresholds is borderline too.
  const similarities = cases.map((item) => item.recorded.similarity).sort();
  assert.deepEqual(similarities, [0.3, 0.7, 0.72]);
  const strong = cases.find((item) => item.recorded.similarity === 0.72)!;
  assert.equal(strong.claim, "营收增长23%，达到41亿美元");
  assert.equal(strong.passage, PASSAGE);
  assert.equal(strong.label, null);
  // Closest to a threshold first.
  assert.equal(cases[0]!.recorded.similarity, 0.7);

  const limited = await calibration.findBorderlineCases({ limit: 1, now: NOW });
  assert.equal(limited.cases.length, 1);
});

test("the export is written to an ignored path and refused anywhere else", async () => {
  const { cases } = await calibration.findBorderlineCases({
    limit: 10,
    now: NOW,
  });
  const out = resolve(scratch, "borderline.jsonl");
  await calibration.writeBorderlineExport(out, cases);
  const lines = (await readFile(out, "utf8")).trim().split("\n");
  assert.equal(lines.length, cases.length);
  assert.equal(JSON.parse(lines[0]!).label, null);

  for (const refused of [
    resolve(repoRoot, "apps/backend/borderline.jsonl"),
    resolve(tmpdir(), "borderline.jsonl"),
  ]) {
    await assert.rejects(
      calibration.writeBorderlineExport(refused, cases),
      /not git-ignored/,
    );
    await assert.rejects(access(refused));
  }
  await mkdir(scratch, { recursive: true });
});
