import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/** API-side rules: what is accepted, who may see a submission, what retries. */

const mocks = vi.hoisted(() => ({
  createOrReuse: vi.fn(),
  failIfInFlight: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  requeue: vi.fn(),
  enqueue: vi.fn(),
  isMarketAdmin: vi.fn(),
}));

vi.mock("./repository", () => ({
  createOrReuseSubmission: mocks.createOrReuse,
  failSubmissionIfInFlight: mocks.failIfInFlight,
  getSubmission: mocks.get,
  listSubmissions: mocks.list,
  requeueFailedSubmission: mocks.requeue,
}));
vi.mock("./queue", () => ({ enqueueSkillIngestJob: mocks.enqueue }));
vi.mock("../../../market/admin", () => ({
  isMarketAdmin: mocks.isMarketAdmin,
}));
vi.mock("../../../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ContentError } from "../../../content/errors";
import {
  createSkillSubmission,
  createSystemSkillSubmission,
  getSystemSkillSubmission,
  decodeSkillSubmissionCursor,
  getSkillSubmission,
  listSkillSubmissions,
  retrySkillSubmission,
} from "./service";

const viewer = { teamId: "team_1", workspaceId: "ws_1", userId: "user_1" };

function row(overrides: Record<string, unknown> = {}) {
  const at = new Date("2026-09-20T00:00:00.000Z");
  return {
    id: "sub_1",
    scope: "workspace",
    teamId: "team_1",
    workspaceId: "ws_1",
    submittedBy: "user_1",
    sourceKind: "github",
    sourceInput: "acme/skills",
    repoOwner: "acme",
    repoName: "skills",
    ref: null,
    subpath: null,
    commitSha: null,
    commitCommittedAt: null,
    target: "workspace",
    status: "queued",
    stage: null,
    stages: {},
    results: [],
    onComplete: null,
    error: null,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const rejectsWith = (status: number, code: string) => (error: unknown) =>
  error instanceof ContentError &&
  error.statusCode === status &&
  error.code === code;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isMarketAdmin.mockReturnValue(false);
  // clearAllMocks keeps implementations, so a rejection set by one test would
  // leak into the next.
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.requeue.mockReset();
  mocks.get.mockReset();
  mocks.createOrReuse.mockResolvedValue({ submission: row(), created: true });
});

test("a new submission stores the parsed source and is queued", async () => {
  const result = await createSkillSubmission({
    ...viewer,
    source: "  https://github.com/acme/skills/tree/main/skills/pdf ",
    install: { skill: "pdf" },
  });
  assert.equal(result.created, true);
  assert.equal(result.submission.createdAt, "2026-09-20T00:00:00.000Z");
  assert.deepEqual(mocks.createOrReuse.mock.calls[0]?.[0], {
    scope: "workspace",
    teamId: "team_1",
    workspaceId: "ws_1",
    submittedBy: "user_1",
    sourceInput: "https://github.com/acme/skills/tree/main/skills/pdf",
    repoOwner: "acme",
    repoName: "skills",
    ref: "main",
    subpath: "skills/pdf",
    onComplete: { install: { skill: "pdf" } },
  });
  assert.equal(mocks.enqueue.mock.calls.length, 1);
});

test("a source that is not a GitHub reference is refused before anything is stored", async () => {
  for (const source of [
    "https://gitlab.com/a/b",
    "not a repo",
    "https://github.com/only-owner",
  ]) {
    await assert.rejects(
      createSkillSubmission({ ...viewer, source }),
      rejectsWith(422, "REGISTRY_SUBMISSION_INVALID_SOURCE"),
      source,
    );
  }
  assert.equal(mocks.createOrReuse.mock.calls.length, 0);
  assert.equal(mocks.enqueue.mock.calls.length, 0);
});

test("a deduped submission is returned as is and not queued a second time", async () => {
  mocks.createOrReuse.mockResolvedValue({
    submission: row({ status: "running" }),
    created: false,
  });
  const result = await createSkillSubmission({
    ...viewer,
    source: "acme/skills",
  });
  assert.equal(result.created, false);
  assert.equal(result.submission.status, "running");
  assert.equal(mocks.enqueue.mock.calls.length, 0);
});

test("a submission that cannot reach the queue is closed, not left queued forever", async () => {
  mocks.enqueue.mockRejectedValue(new Error("redis down"));
  await assert.rejects(
    createSkillSubmission({ ...viewer, source: "acme/skills" }),
    rejectsWith(503, "SKILL_SUBMISSION_ENQUEUE_FAILED"),
  );
  assert.equal(mocks.failIfInFlight.mock.calls[0]?.[0], "sub_1");
  assert.equal(
    mocks.failIfInFlight.mock.calls[0]?.[1].code,
    "SKILL_SUBMISSION_ENQUEUE_FAILED",
  );
});

test("listing asks only for the caller's rows in this workspace and pages by keyset", async () => {
  const rows = [
    row({ id: "c", createdAt: new Date("2026-09-20T00:00:03.000Z") }),
    row({ id: "b", createdAt: new Date("2026-09-20T00:00:02.000Z") }),
    row({ id: "a", createdAt: new Date("2026-09-20T00:00:01.000Z") }),
  ];
  mocks.list.mockResolvedValue(rows);
  const page = await listSkillSubmissions({ ...viewer, limit: 2 });

  assert.deepEqual(mocks.list.mock.calls[0]?.[0], {
    workspaceId: "ws_1",
    submittedBy: "user_1",
    limit: 3,
    before: undefined,
  });
  assert.deepEqual(
    page.items.map((item) => item.id),
    ["c", "b"],
  );
  assert.deepEqual(decodeSkillSubmissionCursor(page.nextCursor!), {
    createdAt: new Date("2026-09-20T00:00:02.000Z"),
    id: "b",
  });

  mocks.list.mockResolvedValue(rows.slice(2));
  assert.equal(
    (await listSkillSubmissions({ ...viewer, limit: 2 })).nextCursor,
    null,
  );
  assert.equal(decodeSkillSubmissionCursor("garbage"), null);
  assert.equal(decodeSkillSubmissionCursor(""), null);
});

test("a submission is visible to its submitter in its workspace, and to market admins", async () => {
  mocks.get.mockResolvedValue(row());
  assert.equal(
    (await getSkillSubmission({ ...viewer, submissionId: "sub_1" })).submission
      .id,
    "sub_1",
  );

  const notFound = rejectsWith(404, "SKILL_SUBMISSION_NOT_FOUND");
  await assert.rejects(
    getSkillSubmission({
      ...viewer,
      userId: "someone-else",
      submissionId: "sub_1",
    }),
    notFound,
  );
  await assert.rejects(
    getSkillSubmission({
      ...viewer,
      workspaceId: "ws_other",
      submissionId: "sub_1",
    }),
    notFound,
  );
  mocks.get.mockResolvedValueOnce(null);
  await assert.rejects(
    getSkillSubmission({ ...viewer, submissionId: "missing" }),
    notFound,
  );

  mocks.isMarketAdmin.mockReturnValue(true);
  assert.equal(
    (
      await getSkillSubmission({
        ...viewer,
        userId: "admin",
        submissionId: "sub_1",
      })
    ).submission.id,
    "sub_1",
  );
  // An admin still goes through the workspace the submission belongs to.
  await assert.rejects(
    getSkillSubmission({
      ...viewer,
      userId: "admin",
      workspaceId: "ws_other",
      submissionId: "sub_1",
    }),
    notFound,
  );
});

test("only a failed submission can be retried", async () => {
  for (const status of ["queued", "running", "succeeded"]) {
    mocks.get.mockResolvedValueOnce(row({ status }));
    await assert.rejects(
      retrySkillSubmission({ ...viewer, submissionId: "sub_1" }),
      rejectsWith(409, "SKILL_SUBMISSION_NOT_RETRYABLE"),
      status,
    );
  }
  assert.equal(mocks.requeue.mock.calls.length, 0);

  mocks.get.mockResolvedValue(row({ status: "failed", attempts: 3 }));
  mocks.requeue.mockResolvedValue(row({ status: "queued", attempts: 3 }));
  const retried = await retrySkillSubmission({
    ...viewer,
    submissionId: "sub_1",
  });
  assert.equal(retried.submission.status, "queued");
  assert.equal(mocks.enqueue.mock.calls[0]?.[0].attempts, 3);

  // Lost the race with a concurrent retry.
  mocks.requeue.mockResolvedValueOnce(null);
  await assert.rejects(
    retrySkillSubmission({ ...viewer, submissionId: "sub_1" }),
    rejectsWith(409, "SKILL_SUBMISSION_NOT_RETRYABLE"),
  );
});

test("retrying while a newer import of the same source runs is a conflict", async () => {
  mocks.get.mockResolvedValue(row({ status: "failed" }));
  mocks.requeue.mockRejectedValue(
    Object.assign(new Error("query failed"), { cause: { code: "23505" } }),
  );
  await assert.rejects(
    retrySkillSubmission({ ...viewer, submissionId: "sub_1" }),
    rejectsWith(409, "SKILL_SUBMISSION_IN_FLIGHT"),
  );
  assert.equal(mocks.enqueue.mock.calls.length, 0);
});

test("stages come back in execution order, whatever order the database stored the keys in", async () => {
  mocks.get.mockResolvedValue(
    row({
      stages: {
        discover: { status: "running", startedAt: "2026-09-20T00:00:03.000Z" },
        download: {
          status: "succeeded",
          startedAt: "2026-09-20T00:00:02.000Z",
        },
        resolve: { status: "succeeded", startedAt: "2026-09-20T00:00:01.000Z" },
      },
    }),
  );
  const { submission } = await getSkillSubmission({
    ...viewer,
    submissionId: "sub_1",
  });
  assert.deepEqual(Object.keys(submission.stages), [
    "resolve",
    "download",
    "discover",
  ]);
});

test("system submissions have no tenant ownership and share queue failure handling", async () => {
  const system = row({
    scope: "system",
    teamId: null,
    workspaceId: null,
    submittedBy: "system",
  });
  mocks.createOrReuse.mockResolvedValue({ submission: system, created: true });
  const result = await createSystemSkillSubmission({
    source: "acme/skills",
    options: { featured: true },
  });
  assert.equal(result.submission.scope, "system");
  assert.equal(result.submission.workspaceId, null);
  const input = mocks.createOrReuse.mock.calls[0]![0];
  assert.equal(input.teamId, null);
  assert.equal(input.workspaceId, null);
  assert.equal(input.submittedBy, "system");
  assert.equal(input.onComplete, null);
  assert.equal(mocks.enqueue.mock.calls.length, 1);
  mocks.enqueue.mockRejectedValue(new Error("redis unavailable"));
  await assert.rejects(
    createSystemSkillSubmission({ source: "acme/skills" }),
    rejectsWith(503, "SKILL_SUBMISSION_ENQUEUE_FAILED"),
  );
});

test("system status and workspace APIs cannot cross scope boundaries", async () => {
  mocks.get.mockResolvedValue(row());
  await assert.rejects(
    getSystemSkillSubmission("sub_1"),
    rejectsWith(404, "SKILL_SUBMISSION_NOT_FOUND"),
  );
  mocks.get.mockResolvedValue(
    row({
      scope: "system",
      teamId: null,
      workspaceId: null,
      submittedBy: "system",
    }),
  );
  assert.equal(
    (await getSystemSkillSubmission("sub_1")).submission.scope,
    "system",
  );
  mocks.isMarketAdmin.mockReturnValue(true);
  await assert.rejects(
    getSkillSubmission({ ...viewer, submissionId: "sub_1" }),
    rejectsWith(404, "SKILL_SUBMISSION_NOT_FOUND"),
  );
  await assert.rejects(
    retrySkillSubmission({ ...viewer, submissionId: "sub_1" }),
    rejectsWith(404, "SKILL_SUBMISSION_NOT_FOUND"),
  );
  assert.equal(mocks.requeue.mock.calls.length, 0);
  await assert.rejects(
    createSkillSubmission({
      ...viewer,
      userId: "system",
      source: "acme/skills",
    }),
  );
});
