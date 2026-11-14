import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

vi.mock("../../workspace/guards", () => ({
  requireContentWorkspace: async () => ({ id: "w1", organizationId: "team-1" }),
}));
vi.mock("../../workspace", () => ({
  workspaceService: {
    resolveBillingOrganizationId: async (input: {
      workspaceOrganizationId: string;
    }) => input.workspaceOrganizationId,
  },
}));
vi.mock("../repository", () => ({ findSourceRecordByExternalUri: vi.fn() }));
vi.mock("../web-provider", () => ({ createDefaultWebProvider: vi.fn() }));

import { BillingAdmissionError } from "../../../shared/model-gateway/index";
import { discoverSources, isSourceDiscoveryAvailable } from "./service";

const search = vi.fn();
const provider = { name: "fake", search, fetch: vi.fn() } as never;
const planQueries = vi.fn();

const input = {
  workspaceId: "w1",
  userId: "u1",
  topic: "solid state batteries",
  requestId: "r1",
};
const deps = (overrides = {}) => ({
  billing: {} as never,
  getProvider: async () => provider,
  planQueries: planQueries as never,
  findExistingSourceId: async () => null,
  ...overrides,
});

beforeEach(() => {
  search.mockReset();
  planQueries.mockReset().mockResolvedValue(["q1", "q2"]);
});

const hit = (url: string, title = "T") => ({ title, url, snippet: "s" });

test("returns the planned queries and de-duplicated candidates", async () => {
  search.mockImplementation(async ({ query }: { query: string }) => ({
    provider: "fake",
    query,
    count: 2,
    results:
      query === "q1"
        ? [hit("https://a.com/1"), hit("https://shared.com/x")]
        : [hit("https://shared.com/x/"), hit("https://b.com/2")],
  }));

  const result = await discoverSources(input, deps());

  assert.deepEqual(result.queries, ["q1", "q2"]);
  assert.deepEqual(
    result.candidates.map((item) => item.url),
    ["https://a.com/1", "https://shared.com/x", "https://b.com/2"],
  );
  assert.equal(search.mock.calls[0]?.[0].limit, 5);
});

test("a page already in the workspace is marked, not hidden", async () => {
  search.mockResolvedValue({
    provider: "fake",
    query: "q",
    count: 1,
    results: [hit("https://a.com/1")],
  });

  const result = await discoverSources(
    input,
    deps({
      findExistingSourceId: async ({ url }: { url: string }) =>
        url === "https://a.com/1" ? "source-9" : null,
    }),
  );

  assert.equal(result.candidates[0]?.existingSourceId, "source-9");
});

test("one failing search does not lose the others", async () => {
  search.mockImplementation(async ({ query }: { query: string }) => {
    if (query === "q1") throw new Error("provider down");
    return {
      provider: "fake",
      query,
      count: 1,
      results: [hit("https://b.com/2")],
    };
  });

  const result = await discoverSources(input, deps());

  assert.deepEqual(
    result.candidates.map((item) => item.url),
    ["https://b.com/2"],
  );
});

test("every search failing is reported as a search failure", async () => {
  search.mockRejectedValue(new Error("provider down"));

  await assert.rejects(discoverSources(input, deps()), /Web search failed/);
});

test("without a web provider discovery is unavailable and nothing is planned", async () => {
  await assert.rejects(
    discoverSources(input, deps({ getProvider: async () => null })),
    /not available/,
  );
  assert.equal(planQueries.mock.calls.length, 0);
  assert.equal(await isSourceDiscoveryAvailable(async () => null), false);
  assert.equal(await isSourceDiscoveryAvailable(async () => provider), true);
});

test("a requester without credits is refused before any search runs", async () => {
  planQueries.mockRejectedValue(
    new BillingAdmissionError({
      allowed: false,
      reason: "insufficient_credits",
      availableCredits: 0,
    } as never),
  );

  await assert.rejects(discoverSources(input, deps()), /not enough credits/);
  assert.equal(search.mock.calls.length, 0);
});

test("planning is charged to the requester's billing organization", async () => {
  search.mockResolvedValue({
    provider: "fake",
    query: "q",
    count: 0,
    results: [],
  });

  await discoverSources(input, deps());

  const call = planQueries.mock.calls[0]?.[0];
  assert.equal(call.teamId, "team-1");
  assert.equal(call.userId, "u1");
  assert.equal(call.topic, "solid state batteries");
});
