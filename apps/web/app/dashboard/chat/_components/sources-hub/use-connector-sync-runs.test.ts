// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  useConnectorSyncRuns,
  type SyncRunScheduler,
} from "./use-connector-sync-runs";

const { listWorkspaceSyncRuns, listSources } = vi.hoisted(() => ({
  listWorkspaceSyncRuns: vi.fn(),
  listSources: vi.fn(),
}));

vi.mock("../../../../../lib/sdk", () => ({
  connectorsClient: { listWorkspaceSyncRuns },
  contentClient: { listSources },
}));

type Timer = { id: number; fn: () => void; kind: "timeout" | "interval" };

function makeScheduler() {
  let seq = 1;
  let now = 0;
  const timers = new Map<number, Timer>();
  const scheduler: SyncRunScheduler = {
    setTimeout: (fn) => {
      const id = seq++;
      timers.set(id, { id, fn, kind: "timeout" });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    setInterval: (fn) => {
      const id = seq++;
      timers.set(id, { id, fn, kind: "interval" });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
    now: () => now,
  };
  return {
    scheduler,
    advance: (ms: number) => {
      now += ms;
    },
    /** Fire the earliest still-pending one-shot timeout (removing it first). */
    fireNextTimeout() {
      const next = [...timers.values()]
        .filter((t) => t.kind === "timeout")
        .sort((a, b) => a.id - b.id)[0];
      if (!next) return false;
      timers.delete(next.id);
      next.fn();
      return true;
    },
    pendingTimeouts: () =>
      [...timers.values()].filter((t) => t.kind === "timeout").length,
  };
}

class FakeBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  closed = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  close() {
    this.closed = true;
  }
  /** Simulate a message arriving from another tab. */
  deliver(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  postedOfType(type: string) {
    return this.posted.filter(
      (m): m is { type: string } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type: string }).type === type,
    );
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

function sourceRecord(id: string, connectorId: string) {
  return {
    id,
    title: id.toUpperCase(),
    sourceType: "file",
    parentSourceId: null,
    status: "indexed",
    mimeType: "text/plain",
    contentText: null,
    connectorId,
    externalUri: null,
    metadata: null,
    storageKey: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type HookInput = Parameters<typeof useConnectorSyncRuns>[0];
type HookApi = ReturnType<typeof useConnectorSyncRuns>;

async function renderHook(input: HookInput) {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  const captured: { api: HookApi | null } = { api: null };
  function Harness(props: HookInput) {
    captured.api = useConnectorSyncRuns(props);
    return null;
  }
  await act(async () => {
    created.render(createElement(Harness, input));
  });
  return captured;
}

beforeEach(() => {
  listWorkspaceSyncRuns.mockReset();
  listSources.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("polls active runs and merges incrementally mapped sources", async () => {
  listWorkspaceSyncRuns.mockResolvedValue({
    items: [
      {
        id: "run1",
        connectorId: "c1",
        discoveredCount: 3,
        indexedCount: 1,
        failedCount: 0,
      },
    ],
  });
  listSources.mockResolvedValue({ items: [sourceRecord("s1", "c1")] });

  const mergeIncrementalSources = vi.fn();
  const scheduler = makeScheduler();

  await renderHook({
    workspaceId: "ws1",
    isPollingTab: true,
    mergeIncrementalSources,
    replaceConnectorSources: vi.fn(),
    refreshConnectors: vi.fn(),
    scheduler: scheduler.scheduler,
    channelFactory: () => null, // sole leader, no cross-tab coordination
  });

  // Mount schedules the first poll at delay 0.
  await act(async () => {
    scheduler.fireNextTimeout();
    await flushMicrotasks();
  });

  expect(listWorkspaceSyncRuns).toHaveBeenCalledWith("ws1", {
    status: "active",
  });
  expect(mergeIncrementalSources).toHaveBeenCalledTimes(1);
  const merged = mergeIncrementalSources.mock.calls[0]![0];
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({
    id: "s1",
    type: "TEXT",
    status: "Indexed",
  });
});

test("final-refreshes and refreshes connectors when a tracked run completes", async () => {
  const replaceConnectorSources = vi.fn();
  const refreshConnectors = vi.fn();
  const scheduler = makeScheduler();

  // Poll 1: run1 active. Poll 2: run1 gone -> completed.
  listWorkspaceSyncRuns
    .mockResolvedValueOnce({
      items: [
        {
          id: "run1",
          connectorId: "c1",
          discoveredCount: 2,
          indexedCount: 2,
          failedCount: 0,
        },
      ],
    })
    .mockResolvedValue({ items: [] });
  listSources.mockResolvedValue({ items: [sourceRecord("s1", "c1")] });

  const captured = await renderHook({
    workspaceId: "ws1",
    isPollingTab: true,
    mergeIncrementalSources: vi.fn(),
    replaceConnectorSources,
    refreshConnectors,
    scheduler: scheduler.scheduler,
    channelFactory: () => null,
  });

  // Track run1 so it is known before it disappears from the active set.
  act(() => {
    captured.api?.trackConnectorSyncRun({
      id: "run1",
      connectorId: "c1",
      discoveredCount: 0,
      indexedCount: 0,
      failedCount: 0,
    });
  });

  // Poll 1 (run1 active).
  await act(async () => {
    scheduler.fireNextTimeout();
    await flushMicrotasks();
  });
  // Poll 2 (run1 completed -> final refresh + connectors refresh).
  await act(async () => {
    scheduler.fireNextTimeout();
    await flushMicrotasks();
  });

  expect(replaceConnectorSources).toHaveBeenCalledTimes(1);
  const batches = replaceConnectorSources.mock.calls[0]![0];
  expect(batches[0]).toMatchObject({ connectorId: "c1" });
  expect(refreshConnectors).toHaveBeenCalled();
});

test("backs off and retries after a failed poll", async () => {
  listWorkspaceSyncRuns.mockRejectedValue(new Error("network"));
  const scheduler = makeScheduler();

  await renderHook({
    workspaceId: "ws1",
    isPollingTab: true,
    mergeIncrementalSources: vi.fn(),
    replaceConnectorSources: vi.fn(),
    refreshConnectors: vi.fn(),
    scheduler: scheduler.scheduler,
    channelFactory: () => null,
  });

  await act(async () => {
    scheduler.fireNextTimeout();
    await flushMicrotasks();
  });
  expect(listWorkspaceSyncRuns).toHaveBeenCalledTimes(1);

  // The failed poll must have scheduled a retry timeout.
  expect(scheduler.pendingTimeouts()).toBe(1);

  await act(async () => {
    scheduler.fireNextTimeout();
    await flushMicrotasks();
  });
  expect(listWorkspaceSyncRuns).toHaveBeenCalledTimes(2);
});

test("stops polling after leadership hands off to a lower-id tab", async () => {
  listWorkspaceSyncRuns.mockResolvedValue({ items: [] });
  const channel = new FakeBroadcastChannel();
  const scheduler = makeScheduler();

  await renderHook({
    workspaceId: "ws1",
    isPollingTab: true,
    mergeIncrementalSources: vi.fn(),
    replaceConnectorSources: vi.fn(),
    refreshConnectors: vi.fn(),
    scheduler: scheduler.scheduler,
    channelFactory: () => channel as unknown as BroadcastChannel,
  });

  // Fire the election timeout: this tab is the only visible candidate, so it
  // becomes leader, then schedules the first poll.
  await act(async () => {
    scheduler.fireNextTimeout(); // election -> becomes leader
    await flushMicrotasks();
  });
  expect(channel.postedOfType("leader-heartbeat").length).toBeGreaterThan(0);

  // Fire the leader's poll.
  await act(async () => {
    scheduler.fireNextTimeout();
    await flushMicrotasks();
  });
  expect(listWorkspaceSyncRuns.mock.calls.length).toBeGreaterThan(0);

  // A competing tab with an empty id (sorts before any UUID) claims leadership.
  await act(async () => {
    channel.deliver({
      type: "leader-heartbeat",
      tabId: "",
      visible: true,
      sentAt: scheduler.scheduler.now(),
    });
    await flushMicrotasks();
  });

  // After stepping down, the previously-scheduled poll must no longer hit the API.
  const callsBefore = listWorkspaceSyncRuns.mock.calls.length;
  await act(async () => {
    while (scheduler.fireNextTimeout()) {
      await flushMicrotasks();
    }
  });
  expect(listWorkspaceSyncRuns.mock.calls.length).toBe(callsBefore);
});
