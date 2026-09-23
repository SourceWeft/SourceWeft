vi.mock("./repository", () => ({
  assertSystemSubmissionStorage: vi.fn(async () => undefined),
}));
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
}));

vi.mock("./service", () => ({
  createSystemSkillSubmission: mocks.create,
  getSystemSkillSubmission: mocks.get,
}));

import {
  parseSystemSubmitSources,
  readSystemSubmissions,
  submitSkillSourcesAsSystem,
} from "./system-submit";

beforeEach(() => {
  vi.clearAllMocks();
});

test("platform imports go through the ordinary submission, attributed to the system", async () => {
  mocks.create.mockResolvedValue({
    submission: { id: "s1", status: "queued" },
    created: true,
  });
  const results = await submitSkillSourcesAsSystem(["acme/skills"]);
  assert.deepEqual(mocks.create.mock.calls[0]![0], {
    source: "acme/skills",
  });
  // No install-on-complete: collecting a skill puts it in nobody's workspace.
  assert.equal("install" in mocks.create.mock.calls[0]![0], false);
  assert.deepEqual(results, [
    {
      source: "acme/skills",
      ok: true,
      created: true,
      submission: { id: "s1", status: "queued" },
    },
  ]);
});

test("a refused source is that source's result; the rest are still submitted", async () => {
  mocks.create
    .mockRejectedValueOnce(
      Object.assign(new Error("Unsupported GitHub source"), {
        code: "REGISTRY_SUBMISSION_INVALID_SOURCE",
      }),
    )
    .mockResolvedValueOnce({ submission: { id: "s2" }, created: false });
  const results = await submitSkillSourcesAsSystem(["nope", "ok/repo"]);
  assert.deepEqual(results[0], {
    source: "nope",
    ok: false,
    code: "REGISTRY_SUBMISSION_INVALID_SOURCE",
    message: "Unsupported GitHub source",
  });
  assert.equal(results[1]!.ok, true);
});

test("status is read as the system too, so it sees what it submitted", async () => {
  mocks.get.mockResolvedValue({
    submission: { id: "s1", status: "succeeded" },
  });
  const results = await readSystemSubmissions(["s1"]);
  assert.equal(mocks.get.mock.calls[0]![0], "s1");
  assert.equal(results[0]!.ok, true);
});

test("a source can say whether its skills are featured; a plain string leaves it", async () => {
  mocks.create.mockResolvedValue({
    submission: { id: "s1", status: "queued" },
    created: true,
  });
  await submitSkillSourcesAsSystem([
    { source: "anthropics/skills", featured: true },
    { source: "someone/skills", featured: false },
    "acme/skills",
  ]);
  const calls = mocks.create.mock.calls.map((call) => call[0]);
  assert.deepEqual(calls[0].options, { featured: true });
  assert.deepEqual(calls[1].options, { featured: false });
  assert.equal("options" in calls[2], false);
});

test("stdin sources are strings or {source, featured}; anything else is refused whole", () => {
  assert.deepEqual(
    parseSystemSubmitSources([
      "acme/skills",
      { source: "anthropics/skills", featured: true },
      { source: "x/y" },
    ]),
    [
      "acme/skills",
      { source: "anthropics/skills", featured: true },
      { source: "x/y" },
    ],
  );
  for (const bad of [
    "acme/skills",
    [""],
    [{ source: "" }],
    [{ source: "x/y", featured: "yes" }],
    [{ source: "x/y", verified: true }],
    [42],
  ]) {
    assert.throws(() => parseSystemSubmitSources(bad));
  }
});
