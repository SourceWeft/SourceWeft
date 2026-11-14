import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

const generate = vi.hoisted(() => vi.fn());
vi.mock("./guide-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./guide-generation")>()),
  generateGuideContent: generate,
}));

/**
 * Issue #496: a guide never changes its source's status; quota and "nobody to
 * charge" leave it waiting, and only the final failed attempt marks it failed.
 */

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let service: typeof import("./guide-service");
let admission: typeof import("../../shared/model-gateway/index");
const originalDatabaseUrl = process.env.DATABASE_URL;

let teamId: string;
let workspaceId: string;
let sourceId: string;

const CONTENT = "Revenue grew 23% in fiscal 2025, driven by cloud services.";
const GUIDE = {
  summary: "Revenue grew.",
  topics: ["Revenue"],
  suggestedQuestions: ["What drove growth?"],
};

const ports = (overrides = {}) => ({
  resolveAccess: async () => ({}) as never,
  resolveResponsibleUserId: async () => "owner-1",
  resolveBillingOrganizationId: async () => "billing-team",
  ...overrides,
});

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("source_guide");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  service = await import("./guide-service");
  admission = await import("../../shared/model-gateway/index");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, sourceId] = [randomUUID(), randomUUID(), randomUUID()];
  generate.mockReset();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Guides",
    slug: `guides-${workspaceId}`,
  });
  await schema.db.insert(schema.sources).values({
    id: sourceId,
    teamId,
    workspaceId,
    title: "Annual report",
    contentText: CONTENT,
    contentHash: "hash-1",
    status: "indexed",
  });
});

afterEach(async () => {
  if (schema)
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function run(overrides: Record<string, unknown> = {}, payerPorts = ports()) {
  return service.processSourceGuideJob(
    {
      teamId,
      workspaceId,
      sourceId,
      initiatorUserId: "uploader",
      trigger: "auto",
      isFinalAttempt: false,
      scopeId: "job-1",
      ...overrides,
    },
    { billing: {} as never, payerPorts },
  );
}

async function guide() {
  const [row] = await schema.db
    .select()
    .from(schema.sourceGuides)
    .where(eq(schema.sourceGuides.sourceId, sourceId));
  return row;
}

async function sourceStatus() {
  const [row] = await schema.db
    .select({ status: schema.sources.status })
    .from(schema.sources)
    .where(eq(schema.sources.id, sourceId));
  return row?.status;
}

test("a generated guide is stored as ready with the source hash and the payer", async () => {
  generate.mockResolvedValue(GUIDE);

  assert.deepEqual(await run(), { status: "ready" });

  const row = await guide();
  assert.equal(row?.status, "ready");
  assert.deepEqual(row?.contentJson, GUIDE);
  assert.equal(row?.contentHash, "hash-1");
  assert.equal(row?.payerUserId, "uploader");
  assert.equal(generate.mock.calls[0]?.[0].actorUserId, "uploader");
  assert.equal(generate.mock.calls[0]?.[0].teamId, "billing-team");
});

test("a system run is charged to the workspace's responsible owner", async () => {
  generate.mockResolvedValue(GUIDE);

  await run({ initiatorUserId: null });

  assert.equal((await guide())?.payerUserId, "owner-1");
});

test("with nobody to charge the guide waits and nothing is generated", async () => {
  const result = await run(
    { initiatorUserId: null },
    ports({ resolveResponsibleUserId: async () => null }),
  );

  assert.equal(result.status, "pending");
  const row = await guide();
  assert.equal(row?.status, "pending");
  assert.equal(row?.errorCode, "NO_PAYER");
  assert.equal(generate.mock.calls.length, 0);
});

test("an uploader who lost access is not charged and the owner does not pay instead", async () => {
  const result = await run({}, ports({ resolveAccess: async () => null }));

  assert.equal(result.status, "pending");
  assert.equal((await guide())?.errorCode, "NO_PAYER");
  assert.equal(generate.mock.calls.length, 0);
});

test("an empty balance leaves the guide pending and the job succeeds", async () => {
  generate.mockRejectedValue(
    new admission.BillingAdmissionError({
      allowed: false,
      reason: "insufficient_credits",
      availableCredits: 0,
    } as never),
  );

  const result = await run();

  assert.equal(result.status, "pending");
  const row = await guide();
  assert.equal(row?.status, "pending");
  assert.equal(row?.errorCode, "QUOTA");
  assert.equal(await sourceStatus(), "indexed");
});

test("a model failure is retried, and only the last attempt marks the guide failed", async () => {
  generate.mockRejectedValue(new Error("provider down"));

  await assert.rejects(run({ isFinalAttempt: false }), /provider down/);
  assert.equal((await guide())?.status, "generating");

  const result = await run({ isFinalAttempt: true });
  assert.equal(result.status, "failed");
  const row = await guide();
  assert.equal(row?.status, "failed");
  assert.equal(row?.errorCode, "MODEL");
  assert.equal(await sourceStatus(), "indexed");
});

test("a source without text fails as empty without calling the model", async () => {
  await schema.db
    .update(schema.sources)
    .set({ contentText: "  " })
    .where(eq(schema.sources.id, sourceId));

  const result = await run();

  assert.equal(result.status, "failed");
  assert.equal((await guide())?.errorCode, "EMPTY_SOURCE");
  assert.equal(generate.mock.calls.length, 0);
});

test("a regeneration keeps the previous guide until the new one is ready", async () => {
  generate.mockResolvedValue(GUIDE);
  await run();

  generate.mockRejectedValue(new Error("provider down"));
  await run({ trigger: "manual", isFinalAttempt: true });

  const row = await guide();
  assert.equal(row?.status, "failed");
  assert.deepEqual(row?.contentJson, GUIDE);
});

test("a guide made from older content reads as stale", async () => {
  generate.mockResolvedValue(GUIDE);
  await run();
  const { toSourceGuide } = await import("./guide-repository");

  const row = (await guide())!;
  assert.equal(toSourceGuide(row, "hash-1").stale, false);
  assert.equal(toSourceGuide(row, "hash-2").stale, true);
});

test("a deleted source's guide goes with it and a missing source is skipped", async () => {
  await schema.db.delete(schema.sources).where(eq(schema.sources.id, sourceId));

  const result = await run();

  assert.equal(result.status, "skipped");
  assert.equal(await guide(), undefined);
});
