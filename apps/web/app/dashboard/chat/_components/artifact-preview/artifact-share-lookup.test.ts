import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ShareLink } from "@sourceweft/contracts";

const getArtifactShare = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { getArtifactShare },
}));

import {
  forgetArtifactShare,
  loadArtifactShare,
  resetArtifactShareLookups,
} from "./artifact-share-lookup";

const share = { token: "tok", noindex: false } as unknown as ShareLink;

beforeEach(() => {
  getArtifactShare.mockReset();
  resetArtifactShareLookups();
});
afterEach(() => {
  vi.useRealTimers();
});

test("callers that overlap share one outstanding request", async () => {
  let release: (value: unknown) => void = () => {};
  getArtifactShare.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const first = loadArtifactShare("workspace-1", "artifact-1");
  const second = loadArtifactShare("workspace-1", "artifact-1");
  const other = loadArtifactShare("workspace-1", "artifact-2");
  assert.equal(getArtifactShare.mock.calls.length, 2);
  assert.deepEqual(getArtifactShare.mock.calls, [
    ["workspace-1", "artifact-1"],
    ["workspace-1", "artifact-2"],
  ]);
  release({ share });
  assert.equal(await first, share);
  assert.equal(await second, share);
  assert.equal(await other, share);
});

test("a settled lookup is reused only within the burst window", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-18T00:00:00.000Z") });
  getArtifactShare.mockResolvedValueOnce({ share });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), share);
  vi.setSystemTime(new Date("2026-10-18T00:00:01.500Z"));
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), share);
  assert.equal(getArtifactShare.mock.calls.length, 1);
  vi.setSystemTime(new Date("2026-10-18T00:00:02.500Z"));
  getArtifactShare.mockResolvedValueOnce({ share: null });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), null);
  assert.equal(getArtifactShare.mock.calls.length, 2);
});

test("forgetting after a mutation makes the next caller fetch fresh", async () => {
  getArtifactShare.mockResolvedValueOnce({ share });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), share);
  forgetArtifactShare("workspace-1", "artifact-1");
  getArtifactShare.mockResolvedValueOnce({ share: null });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), null);
  assert.equal(getArtifactShare.mock.calls.length, 2);
});

test("a rejection reaches every waiting caller, is not remembered, and clears the slot", async () => {
  getArtifactShare.mockRejectedValueOnce(new Error("forbidden"));
  const first = loadArtifactShare("workspace-1", "artifact-1");
  const second = loadArtifactShare("workspace-1", "artifact-1");
  await assert.rejects(first, /forbidden/);
  await assert.rejects(second, /forbidden/);
  getArtifactShare.mockResolvedValueOnce({ share: null });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), null);
  assert.equal(getArtifactShare.mock.calls.length, 2);
});
