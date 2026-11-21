// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArtifactSummaryItem } from "../types";

const sdk = vi.hoisted(() => ({
  contentClient: { listArtifactSummaries: vi.fn() },
}));
vi.mock("../../../../../../lib/sdk", () => sdk);

import { flush, mountWithIntl, unmountAll } from "@/test/react";
import { useArtifacts } from "./use-artifacts";

function row(id: string, status: ArtifactSummaryItem["status"]): ArtifactSummaryItem {
  return {
    id,
    workspaceId: "ws-poll",
    threadId: null,
    artifactType: "table",
    status,
    title: id,
    promptExcerpt: null,
    visibility: "workspace",
    isPublic: false,
    awaitingSharedApproval: false,
    createdAt: "2026-11-21T00:00:00.000Z",
    completedAt: status === "ready" ? "2026-11-21T00:01:00.000Z" : null,
    updatedAt: "2026-11-21T00:01:00.000Z",
    hasPrimaryFile: false,
    primaryFileUrl: null,
    previewImage: null,
  };
}

const seen: { statuses: string; loading: boolean }[] = [];
const workspaceRef = { current: "ws-poll" as string | null };

function Harness() {
  const state = useArtifacts({
    workspaceId: "ws-poll",
    artifactsRefreshKey: 0,
    currentWorkspaceIdRef: workspaceRef,
    enabled: true,
  });
  seen.push({
    statuses: state.artifacts.map((item) => `${item.id}:${item.status}`).join(","),
    loading: state.isLoadingArtifacts,
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seen.length = 0;
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush(3);
}

test("a generating artifact turns ready on its own, without a loading flash, then polling stops", async () => {
  sdk.contentClient.listArtifactSummaries
    .mockResolvedValueOnce({ items: [row("t1", "running"), row("t0", "ready")], nextCursor: null })
    .mockResolvedValueOnce({ items: [row("t1", "running"), row("t0", "ready")], nextCursor: null })
    .mockResolvedValue({ items: [row("t1", "ready"), row("t0", "ready")], nextCursor: null });
  await mountWithIntl(<Harness />);
  await flush(5);
  expect(seen.at(-1)!.statuses).toBe("t1:running,t0:ready");
  const loadedAt = seen.length;

  await tick(5_000);
  expect(seen.at(-1)!.statuses).toBe("t1:running,t0:ready");
  await tick(5_000);
  expect(seen.at(-1)!.statuses).toBe("t1:ready,t0:ready");
  // The list never went back to its loading state while it was watched.
  expect(seen.slice(loadedAt).some((state) => state.loading)).toBe(false);

  const calls = sdk.contentClient.listArtifactSummaries.mock.calls.length;
  await tick(20_000);
  expect(sdk.contentClient.listArtifactSummaries).toHaveBeenCalledTimes(calls);
});

test("the watch gives up after 15 minutes when a run never settles", async () => {
  sdk.contentClient.listArtifactSummaries.mockResolvedValue({
    items: [row("stuck", "pending")],
    nextCursor: null,
  });
  await mountWithIntl(<Harness />);
  await flush(5);
  await tick(15 * 60_000 + 5_000);
  const calls = sdk.contentClient.listArtifactSummaries.mock.calls.length;
  await tick(60_000);
  expect(sdk.contentClient.listArtifactSummaries).toHaveBeenCalledTimes(calls);
});
