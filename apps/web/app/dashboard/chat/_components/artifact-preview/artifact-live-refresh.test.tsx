// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";

const sdk = vi.hoisted(() => ({
  contentClient: {
    getArtifact: vi.fn(),
    getTableFreshness: vi.fn(),
    deleteArtifact: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../../../lib/sdk", () => ({ ...sdk, apiBaseUrl: "http://api.test" }));
vi.mock("./artifact-share-lookup", () => ({
  loadArtifactShare: vi.fn(async () => null),
  forgetArtifactShare: vi.fn(),
}));
vi.mock("@sourceweft/preview/react", () => ({ Preview: () => null }));

import { flush, mountWithIntl, unmountAll, withIntl } from "@/test/react";
import type { ArtifactListItem } from "../sources-hub/types";
import { ArtifactPreviewPanel } from "./artifact-preview-panel";
import { tableFixtureEn } from "./table-test-fixtures";

const POLL_MS = 3_000;

function tableArtifact(
  status: string,
  payloadJson: Record<string, unknown>,
  updatedAt: string,
  id = "artifact-1",
) {
  return {
    id,
    artifactVersionId: status === "ready" ? "version-1" : null,
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    artifactType: "table",
    status,
    title: "Table: Alpha Phone +2",
    promptText: null,
    payloadJson,
    storageBucket: null,
    storageKey: null,
    previewStorageKey: null,
    previewMetadataJson: {},
    errorCode: status === "failed" ? "MODEL_UNAVAILABLE" : null,
    errorMessage: null,
    visibility: "private",
    isPublic: false,
    createdBy: "user-1",
    completedAt: status === "ready" ? updatedAt : null,
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt,
    previewUrl: null,
    capabilities: {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: true,
      canRenderClientSide: true,
    },
  } as unknown as ArtifactListItem;
}

const progress = (done: number, total: number) => ({
  table: { progress: { stage: "fill", done, total } },
});

const pending = tableArtifact("pending", progress(0, 3), "2026-11-21T10:00:00.000Z");
const running = tableArtifact("running", progress(2, 3), "2026-11-21T10:00:05.000Z");
const ready = tableArtifact("ready", tableFixtureEn, "2026-11-21T10:00:09.000Z");

function text() {
  return document.body.textContent ?? "";
}

async function tick(ms = POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush(5);
}

function renderPanel(artifact: ArtifactListItem, onClose?: () => void) {
  return mountWithIntl(
    <ArtifactPreviewPanel artifact={artifact} onClose={onClose} workspaceId="workspace-1" />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  sdk.contentClient.getTableFreshness.mockResolvedValue({
    state: "fresh",
    changedSourceIds: [],
    deletedSourceIds: [],
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("a running table in the preview panel", () => {
  test("polling updates the panel from pending to running with done/total, then to ready, and stops", async () => {
    sdk.contentClient.getArtifact
      .mockResolvedValueOnce({ artifact: running })
      .mockResolvedValueOnce({ artifact: ready });
    await renderPanel(pending);
    expect(text()).toContain("Completed 0 of 3 sources");
    expect(sdk.contentClient.getArtifact).not.toHaveBeenCalled();

    await tick();
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledWith("workspace-1", "artifact-1");
    expect(text()).toContain("Completed 2 of 3 sources");

    await tick();
    expect(text()).toContain("Alpha Phone");
    expect(text()).not.toContain("Completed 2 of 3 sources");

    await tick(POLL_MS * 5);
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(2);
  });

  test("it stops when the panel closes", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue({ artifact: running });
    const panel = await renderPanel(pending);
    await tick();
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(1);

    await panel.unmount();
    await tick(POLL_MS * 5);
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(1);
  });

  test("it follows the panel to another artifact and never applies the old one's answer", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue({ artifact: running });
    const panel = await renderPanel(pending);
    const other = tableArtifact("ready", tableFixtureEn, "2026-11-21T10:00:01.000Z", "artifact-2");
    await panel.render(
      withIntl(<ArtifactPreviewPanel artifact={other} workspaceId="workspace-1" />),
    );
    await tick(POLL_MS * 5);
    expect(sdk.contentClient.getArtifact).not.toHaveBeenCalled();
    expect(text()).toContain("Alpha Phone");
  });

  test("it stops after repeated errors and keeps the last state", async () => {
    sdk.contentClient.getArtifact.mockRejectedValue(
      new HttpClientError({ message: "down", status: 503, statusText: "Unavailable", code: "UNAVAILABLE" }),
    );
    await renderPanel(running);
    await tick();
    await tick();
    await tick();
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(3);
    await tick(POLL_MS * 5);
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(3);
    expect(text()).toContain("Completed 2 of 3 sources");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  test("a newer artifact from the parent wins over an older poll answer", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue({ artifact: running });
    const panel = await renderPanel(pending);
    await panel.render(
      withIntl(<ArtifactPreviewPanel artifact={ready} workspaceId="workspace-1" />),
    );
    await flush(5);
    expect(text()).toContain("Alpha Phone");
    await tick(POLL_MS * 5);
    expect(sdk.contentClient.getArtifact).not.toHaveBeenCalled();
    expect(text()).toContain("Alpha Phone");
  });

  test("it gives up after about fifteen minutes", async () => {
    sdk.contentClient.getArtifact.mockResolvedValue({ artifact: running });
    await renderPanel(pending);
    await tick(16 * 60_000);
    const calls = sdk.contentClient.getArtifact.mock.calls.length;
    expect(calls).toBeGreaterThan(250);
    expect(calls).toBeLessThanOrEqual(300);
    await tick(POLL_MS * 5);
    expect(sdk.contentClient.getArtifact).toHaveBeenCalledTimes(calls);
  });
});
