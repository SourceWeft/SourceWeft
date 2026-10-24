import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configured: false,
  stored: vi.fn(async (_ids: string[]) => new Map<string, { iconCandidates?: unknown; iconDecision?: unknown }>()),
  claimed: vi.fn(async (_ids: string[]) => new Map<string, string[]>()),
  run: vi.fn(),
}));

vi.mock("../../../shared/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../shared/config", () => ({
  config: { publicS3: { baseUrl: "https://assets.test", bucket: "b" } },
}));
vi.mock("./store", () => ({
  canStoreMcpIcons: () => mocks.configured,
  storeHashedMcpIcon: vi.fn(),
}));
vi.mock("../ingest/repository", () => ({ findStoredIconProvenance: mocks.stored }));
vi.mock("./icon-dry-run-repository", () => ({ findClaimedDomains: mocks.claimed }));
vi.mock("./icon-state-repository", () => ({ iconStateStore: {} }));
vi.mock("./icon-dry-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./icon-dry-run")>()),
  runIconDryRun: mocks.run,
}));

import { registryIconDryRun } from "./federation-step";
import { emptyIconDryRunCounts } from "./icon-dry-run";

const entry = {
  key: "io.github.acme/mcp@1.0.0",
  identifier: "io.github.acme/mcp",
  current: { iconSource: "github-avatar" },
};
const NOW = new Date("2026-10-24T12:00:00.000Z");

beforeEach(() => {
  mocks.configured = false;
  mocks.stored.mockClear();
  mocks.run.mockReset();
});

describe("registryIconDryRun", () => {
  test("without the public bucket it reports a skip, keeps stored records and runs nothing", async () => {
    const record = { iconCandidates: { version: 1 }, iconDecision: { version: 1 } };
    mocks.stored.mockResolvedValueOnce(new Map([[entry.key, record]]));
    const { provenance, counts } = await registryIconDryRun([entry], NOW);
    expect(counts).toMatchObject({ entries: 1, skipped: 1 });
    expect(provenance.get(entry.key)).toEqual(record);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  test("a run failure is counted, never thrown, and stored records survive", async () => {
    mocks.configured = true;
    mocks.stored.mockResolvedValueOnce(
      new Map([[entry.key, { iconCandidates: { kept: true } }]]),
    );
    mocks.run.mockRejectedValueOnce(new Error("database down"));
    const { provenance, counts } = await registryIconDryRun([entry], NOW);
    expect(counts.failed).toBe(1);
    expect(provenance.get(entry.key)).toEqual({ iconCandidates: { kept: true }, iconDecision: undefined });
  });

  test("results replace stored records and counts are returned", async () => {
    mocks.configured = true;
    mocks.claimed.mockResolvedValueOnce(new Map([[entry.identifier, ["acme.dev"]]]));
    mocks.run.mockResolvedValueOnce({
      results: new Map([[entry.key, { candidates: { version: 1, items: [] }, decision: { outcome: "placeholder" } }]]),
      counts: { ...emptyIconDryRunCounts(), entries: 1, collected: 1, placeholders: 1 },
    });
    const { provenance, counts } = await registryIconDryRun([entry], NOW);
    expect(counts).toMatchObject({ collected: 1, placeholders: 1 });
    expect(provenance.get(entry.key)).toEqual({
      iconCandidates: { version: 1, items: [] },
      iconDecision: { outcome: "placeholder" },
    });
    const targets = mocks.run.mock.calls[0]![0];
    expect(targets[0].claimedDomains).toEqual(["acme.dev"]);
    expect(mocks.run.mock.calls[0]![2].ownStorageHost).toBe("assets.test");
  });
});
