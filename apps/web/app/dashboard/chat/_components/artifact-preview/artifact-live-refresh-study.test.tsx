// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({ contentClient: { getArtifact: vi.fn() } }));
vi.mock("../../../../../lib/sdk", () => sdk);

import { flush, mount, unmountAll } from "@/test/react";
import type { ArtifactListItem } from "../sources-hub/types";
import {
  ARTIFACT_LIVE_REFRESH,
  LIVE_REFRESH_INTERVAL_MS,
  refreshLiveArtifact,
  useLiveArtifact,
} from "./artifact-live-refresh";

function quiz(status: string, payloadJson: Record<string, unknown>, updatedAt: string) {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    artifactType: "quiz",
    status,
    payloadJson,
    updatedAt,
  } as unknown as ArtifactListItem;
}

const content = { kind: "quiz", items: [] };
const ready = quiz("ready", content, "2026-11-22T10:00:00.000Z");
const regenerating = quiz(
  "ready",
  { ...content, study: { regeneration: { versionNo: 2, status: "running" } } },
  "2026-11-22T10:00:05.000Z",
);
const published = quiz("ready", { ...content, items: [] }, "2026-11-22T10:01:00.000Z");

const shown: ArtifactListItem[] = [];
function Probe({ artifact }: { artifact: ArtifactListItem }) {
  shown.push(useLiveArtifact(artifact, "workspace-1"));
  return null;
}

async function tick(ms = LIVE_REFRESH_INTERVAL_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush(4);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  shown.length = 0;
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("live refresh of study artifacts", () => {
  test("a ready set refreshes while its next version is generated, and stops when it publishes", () => {
    const running = ARTIFACT_LIVE_REFRESH.quiz!;
    expect(running(quiz("pending", {}, ready.updatedAt as string))).toBe(true);
    expect(running(ready)).toBe(false);
    expect(running(regenerating)).toBe(true);
    expect(
      running(
        quiz(
          "ready",
          { ...content, study: { regeneration: { versionNo: 2, status: "failed" } } },
          "2026-11-22T10:00:09.000Z",
        ),
      ),
    ).toBe(false);
    for (const type of ["flashcards", "mindmap"]) {
      expect(ARTIFACT_LIVE_REFRESH[type]!(regenerating)).toBe(true);
    }
  });

  test("queuing a regeneration makes the open preview follow it until it publishes", async () => {
    sdk.contentClient.getArtifact.mockResolvedValueOnce({ artifact: regenerating });
    await mount(createElement(Probe, { artifact: ready }));
    // A ready set is not polled.
    await tick();
    expect(sdk.contentClient.getArtifact).not.toHaveBeenCalled();

    await act(async () => refreshLiveArtifact("artifact-1"));
    await flush(4);
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(1);
    expect(shown.at(-1)).toBe(regenerating);

    sdk.contentClient.getArtifact.mockResolvedValueOnce({ artifact: published });
    await tick();
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(2);
    expect(shown.at(-1)).toBe(published);

    await tick();
    await tick();
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(2);
  });

  test("a request for another artifact reads nothing", async () => {
    await mount(createElement(Probe, { artifact: ready }));
    await act(async () => refreshLiveArtifact("artifact-2"));
    await flush(4);
    expect(sdk.contentClient.getArtifact).not.toHaveBeenCalled();
  });
});
