import { describe, expect, test } from "vitest";
import {
  createMemoryIconStateStore,
  ICON_BACKOFF_BASE_MS,
  ICON_BACKOFF_MAX_MS,
  ICON_SUCCESS_REFRESH_MS,
  nextIconAttempt,
  withIconScope,
} from "./icon-state";

const T0 = new Date("2026-10-24T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;

describe("nextIconAttempt", () => {
  test("success and definite refusals are refreshed after 30 days", () => {
    for (const status of ["ok", "denied"] as const) {
      expect(nextIconAttempt(status, 5, T0)).toEqual({
        nextAttemptAt: at(ICON_SUCCESS_REFRESH_MS),
        errorCount: 0,
      });
    }
  });

  test("errors back off exponentially to a ceiling", () => {
    const delays: number[] = [];
    let count = 0;
    for (let i = 0; i < 12; i += 1) {
      const next = nextIconAttempt(i % 2 ? "deferred" : "error", count, T0);
      count = next.errorCount;
      delays.push(next.nextAttemptAt.getTime() - T0.getTime());
    }
    expect(delays[0]).toBe(ICON_BACKOFF_BASE_MS);
    expect(delays[1]).toBe(ICON_BACKOFF_BASE_MS * 2);
    expect(Math.max(...delays)).toBe(ICON_BACKOFF_MAX_MS);
    expect(delays.at(-1)).toBe(ICON_BACKOFF_MAX_MS);
    expect(count).toBeLessThanOrEqual(8);
  });
});

describe("withIconScope", () => {
  test("fetches once, then serves every other caller from the shared cache", async () => {
    const state = createMemoryIconStateStore();
    let fetches = 0;
    const run = () =>
      withIconScope<{ n: number }>(state, "site:example.com", { owner: "w1", now: T0 }, async () => {
        fetches += 1;
        return { status: "ok", result: { n: fetches } };
      });
    const first = await run();
    const second = await withIconScope<{ n: number }>(
      state,
      "site:example.com",
      { owner: "w2", now: at(DAY) },
      async () => {
        fetches += 1;
        return { status: "ok", result: { n: 99 } };
      },
    );
    expect(first).toMatchObject({ kind: "fetched", result: { n: 1 } });
    expect(second).toMatchObject({ kind: "cached", status: "ok", result: { n: 1 } });
    expect(fetches).toBe(1);
  });

  test("refreshes after 30 days", async () => {
    const state = createMemoryIconStateStore();
    await withIconScope(state, "site:example.com", { owner: "w1", now: T0 }, async () => ({
      status: "ok",
      result: { v: 1 },
    }));
    const later = await withIconScope(
      state,
      "site:example.com",
      { owner: "w1", now: at(ICON_SUCCESS_REFRESH_MS + 1000) },
      async () => ({ status: "ok", result: { v: 2 } }),
    );
    expect(later).toMatchObject({ kind: "fetched", result: { v: 2 } });
  });

  test("a held lease makes other workers back off, and an expired one is taken over", async () => {
    const state = createMemoryIconStateStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = withIconScope(state, "site:a.com", { owner: "w1", now: T0 }, async () => {
      await gate;
      return { status: "ok", result: { by: "w1" } };
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const busy = await withIconScope(state, "site:a.com", { owner: "w2", now: at(1000) }, async () => ({
      status: "ok",
      result: { by: "w2" },
    }));
    expect(busy).toEqual({ kind: "busy" });
    release();
    await slow;

    // A crashed worker's lease: take it over once it has expired.
    state.rows.set("site:b.com", {
      scope: "site:b.com",
      status: "deferred",
      resultJson: null,
      errorCount: 0,
      fetchedAt: null,
      nextAttemptAt: T0,
      leaseOwner: "dead",
      leaseUntil: at(60_000),
    });
    expect(
      await withIconScope(state, "site:b.com", { owner: "w3", now: at(30_000) }, async () => ({ status: "ok" })),
    ).toEqual({ kind: "busy" });
    expect(
      await withIconScope(state, "site:b.com", { owner: "w3", now: at(61_000) }, async () => ({ status: "ok" })),
    ).toMatchObject({ kind: "fetched" });
  });

  test("an error is recorded with a backoff and not retried inside it", async () => {
    const state = createMemoryIconStateStore();
    let calls = 0;
    const boom = async () => {
      calls += 1;
      throw new Error("network");
    };
    const first = await withIconScope(state, "url:x", { owner: "w", now: T0 }, boom);
    expect(first).toMatchObject({ kind: "fetched", status: "error" });
    const inside = await withIconScope(state, "url:x", { owner: "w", now: at(ICON_BACKOFF_BASE_MS - 1) }, boom);
    expect(inside).toMatchObject({ kind: "cached", status: "error" });
    expect(calls).toBe(1);
    const after = await withIconScope(state, "url:x", { owner: "w", now: at(ICON_BACKOFF_BASE_MS + 1) }, boom);
    expect(after).toMatchObject({ kind: "fetched", status: "error" });
    expect(calls).toBe(2);
    expect(state.rows.get("url:x")!.errorCount).toBe(2);
    // The second backoff is twice as long.
    expect(state.rows.get("url:x")!.nextAttemptAt.getTime() - (T0.getTime() + ICON_BACKOFF_BASE_MS + 1)).toBe(
      ICON_BACKOFF_BASE_MS * 2,
    );
  });

  test("a success resets the failure count", async () => {
    const state = createMemoryIconStateStore();
    await withIconScope(state, "url:y", { owner: "w", now: T0 }, async () => ({ status: "deferred" }));
    await withIconScope(state, "url:y", { owner: "w", now: at(DAY) }, async () => ({ status: "ok", result: {} }));
    expect(state.rows.get("url:y")).toMatchObject({ status: "ok", errorCount: 0 });
  });
});

describe("hash domains", () => {
  test("counts brand labels, not domains: notion.so and notion.com are one", async () => {
    const state = createMemoryIconStateStore();
    const sha = "a".repeat(64);
    await state.recordHashDomain({ sha256: sha, domain: "notion.so", label: "notion" });
    await state.recordHashDomain({ sha256: sha, domain: "notion.com", label: "notion" });
    expect(await state.countHashLabels(sha)).toBe(1);
    await state.recordHashDomain({ sha256: sha, domain: "acme.io", label: "acme" });
    await state.recordHashDomain({ sha256: sha, domain: "beta.dev", label: "beta" });
    expect(await state.countHashLabels(sha)).toBe(3);
    expect(await state.countHashLabels("b".repeat(64))).toBe(0);
  });
});
