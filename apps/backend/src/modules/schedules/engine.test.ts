import { describe, expect, it, vi } from "vitest";
import { runScheduleTick, type ScheduleAdapter } from "./engine";

type Item = { occurrence: { id: string }; schedule: { id: string } };
const item = (id: string): Item => ({
  occurrence: { id },
  schedule: { id: `s-${id}` },
});

function adapter(
  calls: string[],
  overrides: Partial<ScheduleAdapter<Item, Item, Item>> = {},
) {
  const base: ScheduleAdapter<Item, Item, Item> = {
    label: "test",
    limit: 10,
    staleAfterMs: 10 * 60_000,
    materialize: vi.fn(async () => {
      calls.push("materialize");
    }),
    listQueued: vi.fn(async () => [item("q1"), item("q2")]),
    reconcileQueued: vi.fn(async (i) => {
      calls.push(`reconcile:${i.occurrence.id}`);
    }),
    listStale: vi.fn(async () => [item("st1")]),
    recoverStale: vi.fn(async (i) => {
      calls.push(`recover:${i.occurrence.id}`);
    }),
    claim: vi.fn(async () => [item("d1"), item("d2")]),
    dispatch: vi.fn(async (i) => {
      calls.push(`dispatch:${i.occurrence.id}`);
    }),
    afterTick: vi.fn(async () => {
      calls.push("after");
    }),
  };
  return { ...base, ...overrides };
}

describe("runScheduleTick", () => {
  it("materializes, reconciles, recovers, dispatches, then runs afterTick in order", async () => {
    const calls: string[] = [];
    await runScheduleTick(adapter(calls), new Date("2026-01-01T00:00:00Z"));
    expect(calls).toEqual([
      "materialize",
      "reconcile:q1",
      "reconcile:q2",
      "recover:st1",
      "dispatch:d1",
      "dispatch:d2",
      "after",
    ]);
  });

  it("asks for twice the limit of queued items and a stale cutoff", async () => {
    const calls: string[] = [];
    const a = adapter(calls);
    const now = new Date("2026-01-01T01:00:00Z");
    await runScheduleTick(a, now);
    expect(a.listQueued).toHaveBeenCalledWith(20);
    expect(a.listStale).toHaveBeenCalledWith({
      cutoff: new Date("2026-01-01T00:50:00Z"),
      limit: 10,
    });
    expect(a.claim).toHaveBeenCalledWith({ now, limit: 10 });
  });

  it("isolates a failing reconcile or recovery and reports it through onError", async () => {
    const calls: string[] = [];
    const onError = vi.fn();
    const boom = new Error("boom");
    await runScheduleTick(
      adapter(calls, {
        onError,
        reconcileQueued: vi.fn(async (i) => {
          if (i.occurrence.id === "q1") throw boom;
          calls.push(`reconcile:${i.occurrence.id}`);
        }),
        recoverStale: vi.fn(async () => {
          throw boom;
        }),
      }),
      new Date(),
    );
    expect(calls).toContain("reconcile:q2");
    expect(calls).toContain("dispatch:d2");
    expect(onError.mock.calls.map((c) => c[0])).toEqual([
      "reconcile",
      "recover",
    ]);
    expect(onError.mock.calls[0]![2]).toBe(boom);
  });

  it("logs and continues when no onError handler is given", async () => {
    const calls: string[] = [];
    await runScheduleTick(
      adapter(calls, {
        reconcileQueued: vi.fn(async () => {
          throw new Error("x");
        }),
      }),
      new Date(),
    );
    expect(calls).toContain("after");
  });

  it("lets a dispatch failure abort the tick", async () => {
    const calls: string[] = [];
    await expect(
      runScheduleTick(
        adapter(calls, {
          dispatch: vi.fn(async () => {
            throw new Error("db down");
          }),
        }),
        new Date(),
      ),
    ).rejects.toThrow("db down");
    expect(calls).not.toContain("after");
  });
});
