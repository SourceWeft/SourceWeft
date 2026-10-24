import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../../modules/market/github-registry/enrich", () => ({
  runGithubRegistryEnrichment: mocks.run,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: mocks.info, warn: vi.fn(), error: vi.fn() },
}));

import {
  GITHUB_REGISTRY_INTERVAL_MS,
  scheduleGithubRegistryEnrichment,
} from "./github-registry";

afterEach(() => {
  vi.clearAllMocks();
});

test("the pass runs once a day", () => {
  assert.equal(GITHUB_REGISTRY_INTERVAL_MS, 24 * 60 * 60 * 1000);
});

test("an interval that fires during a running pass is skipped, and the next one runs", async () => {
  let finish!: () => void;
  mocks.run.mockReturnValueOnce(
    new Promise<unknown>((resolve) => {
      finish = () => resolve(undefined);
    }),
  );
  const first = scheduleGithubRegistryEnrichment();
  assert.equal(await scheduleGithubRegistryEnrichment(), false);
  assert.equal(mocks.run.mock.calls.length, 1);
  finish();
  assert.equal(await first, true);

  mocks.run.mockResolvedValueOnce(undefined);
  assert.equal(await scheduleGithubRegistryEnrichment(), true);
  assert.equal(mocks.run.mock.calls.length, 2);
});

test("a pass that throws releases the guard", async () => {
  mocks.run.mockRejectedValueOnce(new Error("network away"));
  await assert.rejects(scheduleGithubRegistryEnrichment(), /network away/);
  mocks.run.mockResolvedValueOnce(undefined);
  assert.equal(await scheduleGithubRegistryEnrichment(), true);
});
