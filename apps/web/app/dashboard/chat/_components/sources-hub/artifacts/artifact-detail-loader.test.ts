import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ArtifactListItem, ArtifactSummaryItem } from "../types";
import {
  invalidateArtifactDetail,
  loadArtifactDetail,
  resetArtifactDetailCacheForTests,
} from "./artifact-detail-loader";

function summary(updatedAt = "2026-08-23T01:00:00.000Z"): ArtifactSummaryItem {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    artifactType: "report",
    status: "ready",
    title: "Report",
    promptExcerpt: "Report prompt",
    visibility: "private",
    isPublic: false,
    createdAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T01:00:00.000Z",
    updatedAt,
    hasPrimaryFile: false,
    primaryFileUrl: null,
    previewImage: null,
  };
}

function detail(updatedAt = "2026-08-23T01:00:00.000Z") {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    artifactType: "report",
    title: "Report",
    status: "ready",
    updatedAt,
    payloadJson: { body: "full detail" },
  } as unknown as ArtifactListItem;
}

beforeEach(() => {
  resetArtifactDetailCacheForTests();
});

test("concurrent opens of one artifact version share a detail request", async () => {
  let resolveDetail!: (artifact: ArtifactListItem) => void;
  const pending = new Promise<ArtifactListItem>((resolve) => {
    resolveDetail = resolve;
  });
  const load = vi.fn(() => pending);

  const first = loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });
  const second = loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });
  resolveDetail(detail());

  assert.equal(await first, await second);
  assert.equal(load.mock.calls.length, 1);
});

test("matching updatedAt reuses detail and a new version refetches", async () => {
  const load = vi.fn(async () => detail());

  await loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });
  await loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });
  await loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary("2026-08-23T02:00:00.000Z"),
    load,
  });

  assert.equal(load.mock.calls.length, 2);
});

test("failed details are evicted so retry performs a real request", async () => {
  const load = vi
    .fn<
      (workspaceId: string, artifactId: string) => Promise<ArtifactListItem>
    >()
    .mockRejectedValueOnce(new Error("temporary"))
    .mockResolvedValueOnce(detail());

  await assert.rejects(
    loadArtifactDetail({
      workspaceId: "workspace-1",
      summary: summary(),
      load,
    }),
    /temporary/,
  );
  const retried = await loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });

  assert.equal(retried.id, "artifact-1");
  assert.equal(load.mock.calls.length, 2);
});

test("deletion invalidation removes the matching cached detail", async () => {
  const load = vi.fn(async () => detail());
  await loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });

  invalidateArtifactDetail("workspace-1", "artifact-1");
  await loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });

  assert.equal(load.mock.calls.length, 2);
});

test("detail caches are isolated by workspace", async () => {
  const load = vi.fn(async (workspaceId: string) => ({
    ...detail(),
    workspaceId,
  }));

  await loadArtifactDetail({
    workspaceId: "workspace-1",
    summary: summary(),
    load,
  });
  await loadArtifactDetail({
    workspaceId: "workspace-2",
    summary: summary(),
    load,
  });

  assert.equal(load.mock.calls.length, 2);
});
