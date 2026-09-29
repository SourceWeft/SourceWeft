import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi, type MockInstance } from "vitest";
import type {
  CatalogOverviewJson,
  CatalogOverviewLocale,
} from "@sourceweft/db";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  withSystemModel: vi.fn(),
}));
vi.mock("../../shared/model-gateway/system-client", () => ({
  getSystemModelReadiness: mocks.readiness,
  withSystemModel: mocks.withSystemModel,
}));

import { logger } from "../../shared/logger";
import { generateOverview } from "./generate";
import { overviewResultKey } from "./keys";
import type {
  CachedOverview,
  OverviewAnalysisState,
  OverviewStore,
  OverviewSubjectAdapter,
  PublishOverviewInput,
} from "./types";

/**
 * The engine against a fake kind: an in-memory store with the analysis row's
 * fencing rules, and an adapter whose prompt, parse and skip are plain data.
 */

type Subject = {
  versionId: string;
  eligible: boolean;
  fingerprint: string;
  text: string;
};
type Prompt = {
  system: string;
  user: string;
  outputSchema?: Record<string, unknown>;
};
type Classification = { status: "ready" | "needs-review"; slug: string | null };

const overview = (summary: string): CatalogOverviewJson => ({
  summary,
  whatItDoes: `${summary} It does it.`,
  whenToUse: "When needed.",
  requirements: "",
  suggestedCategories: ["tools"],
});
const allLocales = (prefix: string) =>
  ({
    en: overview(`${prefix} en`),
    "zh-CN": overview(`${prefix} zh-CN`),
    "zh-TW": overview(`${prefix} zh-TW`),
  }) satisfies Record<CatalogOverviewLocale, CatalogOverviewJson>;

type Row = OverviewAnalysisState & { error: string | null };

function fakeStore() {
  const rows = new Map<string, Row>();
  const cache = new Map<string, CachedOverview<Classification>>();
  const published: PublishOverviewInput<Subject, Classification>[] = [];
  let next = 0;
  const live = (row: Row | undefined, requestId: string) =>
    row?.requestId === requestId &&
    (row.status === "pending" || row.status === "running");
  const store: OverviewStore<Subject, Classification> = {
    read: vi.fn(async (versionId) => rows.get(versionId) ?? null),
    // Like the SQL: a new reservation replaces an existing row only when forced.
    request: vi.fn(async (versionId, force) => {
      if (rows.has(versionId) && !force) return null;
      const row: Row = {
        requestId: `r${++next}`,
        status: "pending",
        force,
        error: null,
      };
      rows.set(versionId, row);
      return { ...row };
    }),
    claim: vi.fn(async (versionId, requestId) => {
      const row = rows.get(versionId);
      if (!row || !live(row, requestId)) return null;
      row.status = "running";
      row.error = null;
      return { ...row };
    }),
    fail: vi.fn(async (versionId, requestId, error, retry) => {
      const row = rows.get(versionId);
      if (!row || !live(row, requestId)) return;
      row.status = retry ? "pending" : "failed";
      row.error = error;
    }),
    findCached: vi.fn(async (resultKey) => cache.get(resultKey) ?? null),
    publish: vi.fn(async (input) => {
      const row = rows.get(input.subject.versionId);
      if (!row || row.requestId !== input.requestId || row.status !== "running")
        return false;
      published.push(input);
      row.status = input.classification.status;
      row.force = false;
      return true;
    }),
    findInterrupted: vi.fn(async () => []),
  };
  return { store, rows, cache, published };
}

let fake: ReturnType<typeof fakeStore>;
let subjects: Map<string, Subject>;
let adapter: OverviewSubjectAdapter<Subject, Prompt, Classification, "empty">;
// Spies are restored after every test (src/test/setup.ts).
let info: MockInstance<typeof logger.info>;
const rejectionLogs = () =>
  info.mock.calls.filter(([message]) => message.endsWith("output rejected"));

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  mocks.readiness.mockResolvedValue({ ready: true });
  fake = fakeStore();
  subjects = new Map([
    ["v1", { versionId: "v1", eligible: true, fingerprint: "f1", text: "A" }],
  ]);
  adapter = {
    kind: "skill",
    label: "Test",
    purpose: "skill_market.overview",
    subjectRef: (id) => `test:${id}`,
    output: { name: "t", description: "t", schema: {}, maxTokens: 10 },
    loadSubject: vi.fn(async (id: string) => subjects.get(id) ?? null),
    skipReason: (subject) => (subject.text ? null : "empty"),
    buildPrompt: (subject) => ({ system: "sys", user: subject.text }),
    parseOutput: vi.fn((raw: unknown) => ({
      overviews: raw as Record<CatalogOverviewLocale, CatalogOverviewJson>,
      classification: { status: "ready" as const, slug: "tools" },
    })),
    logFields: (subject) => ({ versionId: subject.versionId }),
    store: fake.store,
  };
});

const callModel = () =>
  vi.fn(async () => ({ output: allLocales("fresh"), model: "m" }));

test("without an injected call, the system model gets the adapter's purpose and output spec", async () => {
  const complete = vi.fn(async (_input: unknown) => ({
    structuredOutput: allLocales("system"),
    providerModel: "vendor/model",
    model: "system:market",
  }));
  mocks.withSystemModel.mockImplementation(
    async (_context: unknown, run: (chat: unknown) => Promise<unknown>) =>
      run({ complete }),
  );
  expect(
    await generateOverview(adapter, { versionId: "v1", scopeId: "s" }),
  ).toEqual({ status: "generated", model: "vendor/model" });
  expect(mocks.withSystemModel.mock.calls[0]![0]).toEqual({
    purpose: "skill_market.overview",
    subjectRef: "test:v1",
    scopeId: "s",
  });
  expect(complete.mock.calls[0]![0]).toMatchObject({
    structuredOutput: { name: "t", description: "t", schema: {} },
    maxTokens: 10,
  });
  expect(fake.published[0]?.overviews.en.summary).toBe("system en");
});

test("every locale and the classification are published in one call", async () => {
  const call = callModel();
  expect(
    await generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      callModel: call,
    }),
  ).toEqual({ status: "generated", model: "m" });
  expect(call).toHaveBeenCalledWith({
    prompt: { system: "sys", user: "A" },
    versionId: "v1",
    scopeId: "s",
  });
  expect(fake.store.publish).toHaveBeenCalledTimes(1);
  const [input] = fake.published;
  expect(Object.keys(input!.overviews).sort()).toEqual([
    "en",
    "zh-CN",
    "zh-TW",
  ]);
  expect(input!.classification).toEqual({ status: "ready", slug: "tools" });
  expect(input!.subject.fingerprint).toBe("f1");
  expect(fake.rows.get("v1")?.status).toBe("ready");
  // Accepted output: the generated line only.
  expect(rejectionLogs()).toEqual([]);
  expect(info).toHaveBeenCalledWith("Test overview generated", {
    kind: "skill",
    versionId: "v1",
    model: "m",
  });
});

test("output the kind refuses is logged once with the subject's fields and rethrown unchanged", async () => {
  class RefusedOutputError extends Error {
    readonly code = "evidence_not_in_input";
  }
  const refused = new RefusedOutputError(
    "Evidence for tools does not appear in the input",
  );
  adapter.parseOutput = vi.fn(() => {
    throw refused;
  });
  adapter.logFields = (subject, prompt) => ({
    versionId: subject.versionId,
    identifier: `io.example/${prompt.user}`,
  });
  await expect(
    generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      callModel: callModel(),
    }),
  ).rejects.toBe(refused);
  expect(rejectionLogs()).toEqual([
    [
      "Test overview output rejected",
      {
        kind: "skill",
        versionId: "v1",
        identifier: "io.example/A",
        model: "m",
        error: "Evidence for tools does not appear in the input",
        code: "evidence_not_in_input",
      },
    ],
  ]);
  // Nothing about the answer itself is logged.
  expect(JSON.stringify(info.mock.calls)).not.toContain("fresh en");
  expect(fake.store.publish).not.toHaveBeenCalled();
  // Still the running request: the job records the failure and retries.
  expect(fake.rows.get("v1")?.status).toBe("running");
});

test("a refusal without a code logs the message alone", async () => {
  const refused = new Error("Overview output is not a JSON object");
  adapter.parseOutput = vi.fn(() => {
    throw refused;
  });
  await expect(
    generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      callModel: callModel(),
    }),
  ).rejects.toBe(refused);
  expect(rejectionLogs()).toEqual([
    [
      "Test overview output rejected",
      {
        kind: "skill",
        versionId: "v1",
        model: "m",
        error: "Overview output is not a JSON object",
      },
    ],
  ]);
});

test("a failed model call is not an output rejection", async () => {
  const failure = new Error("gateway timeout");
  await expect(
    generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      callModel: vi.fn(async () => {
        throw failure;
      }),
    }),
  ).rejects.toBe(failure);
  expect(adapter.parseOutput).not.toHaveBeenCalled();
  expect(rejectionLogs()).toEqual([]);
});

test("an answer missing a locale publishes nothing", async () => {
  const call = vi.fn(async () => ({
    output: { en: overview("en"), "zh-CN": overview("cn") },
    model: "m",
  }));
  await expect(
    generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      callModel: call,
    }),
  ).rejects.toThrow(/missing locales: zh-TW/);
  expect(fake.store.publish).not.toHaveBeenCalled();
  // Still the running request: the job records the failure and retries.
  expect(fake.rows.get("v1")?.status).toBe("running");
});

test("a stale request is fenced before any model call", async () => {
  const first = await fake.store.request("v1", false);
  // A regeneration reserves a newer request, fencing the first.
  await fake.store.request("v1", true);
  const call = callModel();
  expect(
    await generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      requestId: first!.requestId,
      callModel: call,
    }),
  ).toEqual({ status: "skipped", reason: "already-generated" });
  expect(call).not.toHaveBeenCalled();
});

test("a request fenced while the model runs does not publish", async () => {
  const call = vi.fn(async () => {
    // A regeneration lands mid-call.
    await fake.store.request("v1", true);
    return { output: allLocales("late"), model: "m" };
  });
  expect(
    await generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      callModel: call,
    }),
  ).toEqual({ status: "skipped", reason: "not-eligible" });
  expect(fake.published).toHaveLength(0);
  expect(fake.rows.get("v1")?.status).toBe("pending");
});

test("a finished version is not generated again", async () => {
  await generateOverview(adapter, {
    versionId: "v1",
    scopeId: "s",
    callModel: callModel(),
  });
  const again = callModel();
  expect(
    await generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s2",
      callModel: again,
    }),
  ).toEqual({ status: "skipped", reason: "already-generated" });
  expect(again).not.toHaveBeenCalled();
});

test("identical input described before is copied, not regenerated", async () => {
  const key = overviewResultKey({
    fingerprint: "f1",
    prompt: { system: "sys", user: "A" },
    model: "model-config",
  });
  fake.cache.set(key, {
    classification: { status: "ready", slug: "tools" },
    model: "cached-model",
    overviews: allLocales("cached"),
  });
  const call = callModel();
  expect(
    await generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      modelConfigurationKey: "model-config",
      callModel: call,
    }),
  ).toEqual({ status: "copied", rows: 3 });
  expect(call).not.toHaveBeenCalled();
  expect(fake.published[0]).toMatchObject({
    model: "cached-model",
    resultKey: key,
    modelConfigurationKey: "model-config",
    overviews: { en: { summary: "cached en" } },
  });
});

test("without a model configuration key nothing is reused", async () => {
  const call = callModel();
  await generateOverview(adapter, {
    versionId: "v1",
    scopeId: "s",
    callModel: call,
  });
  expect(fake.store.findCached).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(1);
});

test("forced regeneration skips the cache and replaces the output", async () => {
  await generateOverview(adapter, {
    versionId: "v1",
    scopeId: "s",
    callModel: callModel(),
  });
  const key = overviewResultKey({
    fingerprint: "f1",
    prompt: { system: "sys", user: "A" },
    model: "model-config",
  });
  fake.cache.set(key, {
    classification: { status: "ready", slug: "tools" },
    model: "cached-model",
    overviews: allLocales("cached"),
  });
  const call = vi.fn(async () => ({
    output: allLocales("forced"),
    model: "m2",
  }));
  expect(
    await generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      force: true,
      modelConfigurationKey: "model-config",
      callModel: call,
    }),
  ).toEqual({ status: "generated", model: "m2" });
  expect(fake.store.request).toHaveBeenLastCalledWith("v1", true);
  expect(fake.store.findCached).not.toHaveBeenCalled();
  expect(fake.published.at(-1)?.overviews.en.summary).toBe("forced en");
});

test("a claimed forced request skips the cache even when the run is not forced", async () => {
  const reserved = await fake.store.request("v1", true);
  const call = callModel();
  await generateOverview(adapter, {
    versionId: "v1",
    scopeId: "s",
    requestId: reserved!.requestId,
    modelConfigurationKey: "model-config",
    callModel: call,
  });
  expect(fake.store.findCached).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(1);
});

test("the result key is the frozen hash of fingerprint, prompt and model", () => {
  const prompt = { system: "sys", user: "A" };
  const key = overviewResultKey({ fingerprint: "f1", prompt, model: "m" });
  expect(key).toBe(
    createHash("sha256")
      .update(JSON.stringify({ bundle: "f1", prompt, model: "m" }))
      .digest("hex"),
  );
  expect(overviewResultKey({ fingerprint: "f2", prompt, model: "m" })).not.toBe(
    key,
  );
  expect(
    overviewResultKey({
      fingerprint: "f1",
      prompt: { ...prompt, user: "B" },
      model: "m",
    }),
  ).not.toBe(key);
  expect(overviewResultKey({ fingerprint: "f1", prompt, model: "n" })).not.toBe(
    key,
  );
  // A prompt's own schema is part of the prompt, and so of the key.
  const withSchema = {
    ...prompt,
    outputSchema: { type: "object", properties: { a: { enum: ["D1"] } } },
  };
  const schemaKey = overviewResultKey({
    fingerprint: "f1",
    prompt: withSchema,
    model: "m",
  });
  expect(schemaKey).not.toBe(key);
  expect(
    overviewResultKey({
      fingerprint: "f1",
      prompt: {
        ...withSchema,
        outputSchema: { type: "object", properties: { a: { enum: ["D2"] } } },
      },
      model: "m",
    }),
  ).not.toBe(schemaKey);
});

test("the prompt's own schema is sent and keyed; the adapter's static one otherwise", async () => {
  const complete = vi.fn(async (_input: unknown) => ({
    structuredOutput: allLocales("system"),
    providerModel: "vendor/model",
    model: "system:market",
  }));
  mocks.withSystemModel.mockImplementation(
    async (_context: unknown, run: (chat: unknown) => Promise<unknown>) =>
      run({ complete }),
  );
  const outputSchema = { type: "object", title: "per input" };
  adapter.buildPrompt = (subject) => ({
    system: "sys",
    user: subject.text,
    outputSchema,
  });
  await generateOverview(adapter, {
    versionId: "v1",
    scopeId: "s",
    modelConfigurationKey: "cfg",
  });
  expect(complete.mock.calls[0]![0]).toMatchObject({
    structuredOutput: { name: "t", description: "t", schema: outputSchema },
  });
  expect(fake.published[0]?.resultKey).toBe(
    overviewResultKey({
      fingerprint: "f1",
      prompt: { system: "sys", user: "A", outputSchema },
      model: "cfg",
    }),
  );
  // The cache is looked up under the same key.
  expect(fake.store.findCached).toHaveBeenCalledWith(
    fake.published[0]?.resultKey,
    "v1",
  );
});

test("skips: missing, ineligible, nothing to describe, model not ready", async () => {
  const call = callModel();
  expect(
    await generateOverview(adapter, {
      versionId: "gone",
      scopeId: "s",
      callModel: call,
    }),
  ).toEqual({ status: "skipped", reason: "missing-version" });

  subjects.set("v2", {
    versionId: "v2",
    eligible: false,
    fingerprint: "f",
    text: "B",
  });
  expect(
    await generateOverview(adapter, {
      versionId: "v2",
      scopeId: "s",
      callModel: call,
    }),
  ).toEqual({ status: "skipped", reason: "not-eligible" });
  // Ineligible versions are not even reserved.
  expect(fake.rows.has("v2")).toBe(false);

  subjects.set("v3", {
    versionId: "v3",
    eligible: true,
    fingerprint: "f",
    text: "",
  });
  expect(
    await generateOverview(adapter, {
      versionId: "v3",
      scopeId: "s",
      callModel: call,
    }),
  ).toEqual({ status: "skipped", reason: "empty" });
  // The kind's skip comes after the claim, so the job can fail the request.
  expect(fake.rows.get("v3")?.status).toBe("running");

  mocks.readiness.mockResolvedValue({ ready: false });
  expect(
    await generateOverview(adapter, {
      versionId: "v1",
      scopeId: "s",
      callModel: call,
    }),
  ).toEqual({ status: "skipped", reason: "system-model-not-ready" });
  expect(call).not.toHaveBeenCalled();
  expect(fake.store.publish).not.toHaveBeenCalled();
});
