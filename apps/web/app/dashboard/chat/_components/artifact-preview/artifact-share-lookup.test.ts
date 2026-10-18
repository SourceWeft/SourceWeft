import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ShareLink } from "@sourceweft/contracts";

const getArtifactShare = vi.hoisted(() => vi.fn());

vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { getArtifactShare },
}));

import {
  loadArtifactShare,
  resetArtifactShareLookups,
} from "./artifact-share-lookup";

const share = { token: "tok", noindex: false } as unknown as ShareLink;

beforeEach(() => {
  getArtifactShare.mockReset();
  resetArtifactShareLookups();
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

test("a settled lookup is not remembered; the next caller fetches fresh", async () => {
  getArtifactShare.mockResolvedValueOnce({ share });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), share);
  getArtifactShare.mockResolvedValueOnce({ share: null });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), null);
  assert.equal(getArtifactShare.mock.calls.length, 2);
});

test("a rejection reaches every waiting caller and clears the slot", async () => {
  getArtifactShare.mockRejectedValueOnce(new Error("forbidden"));
  const first = loadArtifactShare("workspace-1", "artifact-1");
  const second = loadArtifactShare("workspace-1", "artifact-1");
  await assert.rejects(first, /forbidden/);
  await assert.rejects(second, /forbidden/);
  getArtifactShare.mockResolvedValueOnce({ share: null });
  assert.equal(await loadArtifactShare("workspace-1", "artifact-1"), null);
  assert.equal(getArtifactShare.mock.calls.length, 2);
});
