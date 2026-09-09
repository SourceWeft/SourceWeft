/** Real authenticated page-ledger checks; never writes ledger/account rows. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  billingLedgerResponseSchema,
  billingSummaryResponseSchema,
} from "@sourceweft/contracts/billing";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const mode = process.argv[2] || "assert";
assert.ok(["assert", "replay"].includes(mode), "Expected assert or replay");
const manifest = z
  .object({
    workspaceId: z.string().uuid(),
    teamId: z.string(),
    parserVersion: z.string(),
    cases: z
      .array(
        z.object({
          sourceId: z.string().uuid(),
          fileName: z.string(),
          minParsedChars: z.number().int().positive().optional(),
          physicalPages: z.number().int().positive().optional(),
        }),
      )
      .min(1),
  })
  .strict()
  .parse(
    JSON.parse(await readFile(required("E2E_BILLING_CASES_PATH"), "utf8")),
  );
assert.equal(
  new Set(manifest.cases.map((item) => item.sourceId)).size,
  manifest.cases.length,
);
const base = process.env.E2E_API_URL || "http://localhost:3101";
assert.equal(new URL(base).origin, "http://localhost:3101");
const login = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "http://localhost:3100",
  },
  body: JSON.stringify({
    email: required("E2E_EMAIL"),
    password: required("E2E_PASSWORD"),
  }),
  signal: AbortSignal.timeout(30000),
});
assert.equal(login.status, 200, "Test-account login failed");
const actorUserId = (await login.json()).user.id as string;
assert.ok(actorUserId);
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert.ok(cookie);
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: "http://localhost:3100",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
const sourcePath = (id: string) =>
  `/v1/workspaces/${manifest.workspaceId}/sources/${id}`;
async function pageLedger() {
  const all: z.infer<typeof billingLedgerResponseSchema>["items"] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 10; page++) {
    const result = billingLedgerResponseSchema.parse(
      await request(
        `/v1/teams/${manifest.teamId}/billing/ledger?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
    all.push(...result.items);
    if (!result.nextCursor)
      return all.filter(
        (item) => item.unitType === "page" && item.actorUserId === actorUserId,
      );
    cursor = result.nextCursor;
  }
  throw new Error("Test-account ledger exceeded the bounded pagination limit");
}
async function pageSummary() {
  return billingSummaryResponseSchema.parse(
    await request(`/v1/teams/${manifest.teamId}/billing/summary`),
  ).pages;
}
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  mode,
  passed: false,
  cases: [],
};
const results = report.cases as Record<string, unknown>[];
let failure: unknown;
try {
  const before = await pageLedger();
  const beforeSummary = await pageSummary();
  const keys = new Map<string, string>();
  for (const item of manifest.cases) {
    const { source } = await request(sourcePath(item.sourceId));
    const { content } = await request(`${sourcePath(item.sourceId)}/content`);
    assert.equal(source.metadata.fileName, item.fileName);
    assert.equal(source.status, "indexed");
    assert.equal(source.parserVersion, manifest.parserVersion);
    assert.equal(source.metadata.documentParseProviderResolved, "anydoc");
    assert.equal(source.metadata.providerTaskId ?? null, null);
    assert.ok(typeof content === "string" && content.trim());
    if (item.minParsedChars)
      assert.ok(
        content.length >= item.minParsedChars,
        "Fixture did not exceed its required parsed-text threshold",
      );
    const parsedTokens = Math.ceil(content.length / 4);
    // Independent specification formula; do not import the implementation resolver.
    const expectedPages =
      item.physicalPages ?? Math.max(1, Math.ceil(parsedTokens / 1000));
    if (item.physicalPages) {
      assert.equal(source.metadata.pageCount, item.physicalPages);
      assert.equal(source.metadata.pageCountSource, "pdfjs");
    }
    const entries = before.filter(
      (entry) =>
        entry.workspaceId === manifest.workspaceId &&
        entry.referenceId === `source:${item.sourceId}` &&
        entry.eventType === "consume",
    );
    assert.equal(
      entries.length,
      1,
      `${item.fileName}: expected exactly one page consumption`,
    );
    const entry = entries[0]!;
    assert.equal(
      entry.delta,
      -expectedPages,
      `${item.fileName}: actual page-ledger debit differs from specification`,
    );
    assert.equal(source.estimatedPages, expectedPages);
    const originalKey = source.metadata.jobId;
    assert.ok(
      typeof originalKey === "string" &&
        originalKey.startsWith(`source_parse_${item.sourceId}_`),
    );
    assert.equal(
      entry.idempotencyKey,
      `${actorUserId}:${originalKey}`,
      "Original job key does not match the actual scoped ledger key",
    );
    keys.set(item.sourceId, originalKey);
    results.push({
      fileName: item.fileName,
      parsedChars: content.length,
      parsedTokens,
      physicalPages: item.physicalPages ?? null,
      expectedPages,
      ledgerDelta: entry.delta,
      ledgerRows: entries.length,
      idempotencyKeyVerified: true,
    });
  }
  report.pageSummaryBefore = beforeSummary;
  if (mode === "replay") {
    for (const item of manifest.cases) {
      for (let repetition = 0; repetition < 2; repetition++) {
        await request(`${sourcePath(item.sourceId)}/index`, "POST", {
          idempotencyKey: keys.get(item.sourceId),
        });
      }
    }
  }
  const after = await pageLedger();
  const afterSummary = await pageSummary();
  const stableEntries = (entries: typeof before) =>
    entries
      .map((entry) => ({
        id: entry.id,
        delta: entry.delta,
        balanceAfter: entry.balanceAfter,
        idempotencyKey: entry.idempotencyKey,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    stableEntries(after),
    stableEntries(before),
    "Page ledger changed during same-key index replay",
  );
  assert.deepEqual(
    afterSummary,
    beforeSummary,
    "Account page balance changed during same-key index replay",
  );
  report.pageSummaryAfter = afterSummary;
  report.replayCalls = mode === "replay" ? manifest.cases.length * 2 : 0;
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : String(error);
}
const directory = new URL(
  "../../../../output/playwright/anydoc-billing/",
  import.meta.url,
);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL(`ledger-${mode}-results.json`, directory),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (failure) process.exitCode = 1;
