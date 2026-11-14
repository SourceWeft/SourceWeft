import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

const generate = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../content/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../content/queue")>()),
  enqueueSourceGuideGenerateJob: enqueue,
}));
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
  enqueue.mockReset().mockResolvedValue({});
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

const MINUTE = 60_000;

async function setGuide(
  fields: Partial<typeof import("@sourceweft/db").sourceGuides.$inferInsert>,
  ageMs: number,
) {
  await schema.db.insert(schema.sourceGuides).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    sourceId,
    trigger: "auto",
    status: "pending",
    updatedAt: new Date(Date.now() - ageMs),
    ...fields,
  });
}

test("a guide paused for credits is queued again once the interval has passed, for the same payer", async () => {
  await setGuide(
    { status: "pending", errorCode: "QUOTA", payerUserId: "uploader" },
    20 * MINUTE,
  );

  const result = await service.resumePausedGuides();

  assert.equal(result.queued, 1);
  assert.equal(enqueue.mock.calls[0]?.[0].sourceId, sourceId);
  assert.equal(enqueue.mock.calls[0]?.[0].initiatorUserId, "uploader");
  const row = await guide();
  assert.equal(row?.status, "pending");
  assert.equal(row?.errorCode, "QUOTA");
  assert.ok(Date.now() - row!.updatedAt.getTime() < 60_000);
});

test("a guide paused a moment ago is left alone, and a blocked one is not picked again at once", async () => {
  await setGuide({ status: "pending", errorCode: "QUOTA" }, 2 * MINUTE);

  assert.equal((await service.resumePausedGuides()).queued, 0);
  assert.equal(enqueue.mock.calls.length, 0);

  await schema.db
    .update(schema.sourceGuides)
    .set({ updatedAt: new Date(Date.now() - 20 * MINUTE) })
    .where(eq(schema.sourceGuides.sourceId, sourceId));
  assert.equal((await service.resumePausedGuides()).queued, 1);
  assert.equal((await service.resumePausedGuides()).queued, 0);
});

test("a guide with nobody to charge is retried, and one whose job was lost is recovered", async () => {
  await setGuide({ status: "pending", errorCode: "NO_PAYER" }, 20 * MINUTE);
  assert.equal((await service.resumePausedGuides()).queued, 1);
  assert.equal(enqueue.mock.calls[0]?.[0].initiatorUserId, null);

  await schema.db
    .update(schema.sourceGuides)
    .set({
      status: "generating",
      errorCode: null,
      updatedAt: new Date(Date.now() - 45 * MINUTE),
    })
    .where(eq(schema.sourceGuides.sourceId, sourceId));
  assert.equal((await service.resumePausedGuides()).queued, 1);
  assert.equal((await guide())?.errorCode, null);
});

test("ready, failed and recently running guides are never resumed", async () => {
  await setGuide({ status: "failed", errorCode: "MODEL" }, 120 * MINUTE);
  assert.equal((await service.resumePausedGuides()).queued, 0);

  await schema.db
    .update(schema.sourceGuides)
    .set({ status: "generating", errorCode: null, updatedAt: new Date() })
    .where(eq(schema.sourceGuides.sourceId, sourceId));
  assert.equal((await service.resumePausedGuides()).queued, 0);
});

test("one source failing to queue does not stop the sweep", async () => {
  await setGuide({ status: "pending", errorCode: "QUOTA" }, 20 * MINUTE);
  enqueue.mockRejectedValueOnce(new Error("redis down"));

  const result = await service.resumePausedGuides();

  assert.equal(result.queued, 0);
});
