import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createReadinessProbe, READINESS_ABANDON_AFTER_BUDGETS } from "./probe";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("reports ok with a duration and budget per check when all pass", async () => {
  const probe = createReadinessProbe([
    { name: "database", budgetMs: 1_000, run: async () => undefined },
    { name: "catalog", budgetMs: 2_000, run: async () => undefined },
  ]);

  const report = await probe.run();

  assert.equal(report.status, "ok");
  assert.deepEqual(report.failed, []);
  assert.deepEqual(Object.keys(report.checks), ["database", "catalog"]);
  assert.equal(report.checks.database!.status, "ok");
  assert.equal(report.checks.database!.budgetMs, 1_000);
  assert.equal(typeof report.checks.database!.durationMs, "number");
  assert.equal(report.checks.catalog!.reason, undefined);
  assert.ok(!Number.isNaN(Date.parse(report.timestamp)));
});

test("names the check that threw, keeps the others, and never repeats the error's text", async () => {
  const failures: unknown[] = [];
  const probe = createReadinessProbe(
    [
      { name: "database", budgetMs: 1_000, run: async () => undefined },
      {
        name: "catalog",
        budgetMs: 1_000,
        run: async () => {
          throw new Error("connect ECONNREFUSED db.internal:5432");
        },
      },
    ],
    { onFailure: (failure) => failures.push(failure) },
  );

  const report = await probe.run();

  assert.equal(report.status, "unavailable");
  assert.deepEqual(report.failed, ["catalog"]);
  assert.equal(report.checks.database!.status, "ok");
  assert.equal(report.checks.catalog!.status, "failed");
  assert.equal(report.checks.catalog!.reason, "error");
  assert.ok(!JSON.stringify(report).includes("db.internal"));
  // The cause still reaches the server's own log.
  assert.equal(failures.length, 1);
  assert.match(
    String((failures[0] as { error: Error }).error.message),
    /db\.internal/,
  );
});

test("a check that throws synchronously is a failed check, not a failed probe", async () => {
  const probe = createReadinessProbe([
    {
      name: "database",
      budgetMs: 1_000,
      run: () => {
        throw new Error("boom");
      },
    },
  ]);

  const report = await probe.run();

  assert.deepEqual(report.failed, ["database"]);
  assert.equal(report.checks.database!.reason, "error");
});

test("fails a check that has not finished within its budget", async () => {
  vi.useFakeTimers();
  try {
    const stalled = deferred();
    const probe = createReadinessProbe([
      { name: "database", budgetMs: 2_000, run: () => stalled.promise },
      { name: "catalog", budgetMs: 5_000, run: async () => undefined },
    ]);

    const pending = probe.run();
    await vi.advanceTimersByTimeAsync(2_000);
    const report = await pending;

    assert.equal(report.status, "unavailable");
    assert.deepEqual(report.failed, ["database"]);
    assert.equal(report.checks.database!.reason, "timeout");
    assert.ok(report.checks.database!.durationMs >= 2_000);
    assert.equal(report.checks.catalog!.status, "ok");
    stalled.resolve();
  } finally {
    vi.useRealTimers();
  }
});

test("fails a check that finished, but later than its budget", async () => {
  // A clock that jumps: the work settles first, yet took too long.
  const times = [0, 9_000];
  const probe = createReadinessProbe(
    [{ name: "catalog", budgetMs: 5_000, run: async () => undefined }],
    { now: () => times.shift() ?? 9_000 },
  );

  const report = await probe.run();

  assert.deepEqual(report.failed, ["catalog"]);
  assert.equal(report.checks.catalog!.reason, "timeout");
  assert.equal(report.checks.catalog!.durationMs, 9_000);
});

test("calls that arrive during a run share it instead of starting another", async () => {
  const gate = deferred();
  const run = vi.fn(() => gate.promise);
  const probe = createReadinessProbe([
    { name: "database", budgetMs: 1_000, run },
  ]);

  const first = probe.run();
  const second = probe.run();
  await Promise.resolve();
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(run.mock.calls.length, 1);
  assert.equal(a, b);

  // The next call after it finished is a new run.
  await probe.run();
  assert.equal(run.mock.calls.length, 2);
});

test("does not start a check again while its earlier, overdue work is still out", async () => {
  vi.useFakeTimers();
  try {
    const stalled = deferred();
    const run = vi.fn(() => stalled.promise);
    const probe = createReadinessProbe([
      { name: "database", budgetMs: 1_000, run },
    ]);

    const first = probe.run();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal((await first).checks.database!.reason, "timeout");

    // A moment later the query is still out: reported, not piled on.
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await probe.run();
    assert.equal(run.mock.calls.length, 1);
    assert.equal(second.checks.database!.reason, "timeout");
    assert.ok(second.checks.database!.durationMs >= 2_000);

    // Once it settles, the check runs again.
    stalled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    run.mockImplementation(async () => undefined);
    const third = await probe.run();
    assert.equal(run.mock.calls.length, 2);
    assert.equal(third.status, "ok");
  } finally {
    vi.useRealTimers();
  }
});

// A half-open connection: the query never settles. The check must not stay
// failed until the process restarts once the database answers again.
test("abandons work that never settles after a fixed multiple of the budget and probes afresh", async () => {
  vi.useFakeTimers();
  try {
    const never = new Promise<void>(() => undefined);
    const run = vi.fn<() => Promise<void>>(() => never);
    const probe = createReadinessProbe([
      { name: "database", budgetMs: 1_000, run },
    ]);

    const first = probe.run();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal((await first).checks.database!.reason, "timeout");

    // Before the limit: still reported, nothing new started.
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal((await probe.run()).checks.database!.reason, "timeout");
    assert.equal(run.mock.calls.length, 1);

    // Past the limit, with the database back: a fresh probe, and ok.
    await vi.advanceTimersByTimeAsync(1_000 * READINESS_ABANDON_AFTER_BUDGETS);
    run.mockImplementation(async () => undefined);
    const recovered = await probe.run();
    assert.equal(run.mock.calls.length, 2);
    assert.equal(recovered.status, "ok");
    assert.equal(recovered.checks.database!.status, "ok");
  } finally {
    vi.useRealTimers();
  }
});

test("never has more than one abandoned and one live piece of work per check", async () => {
  vi.useFakeTimers();
  try {
    const first = deferred();
    const run = vi.fn<() => Promise<void>>(() => first.promise);
    const probe = createReadinessProbe([
      { name: "database", budgetMs: 1_000, run },
    ]);
    const limit = 1_000 * READINESS_ABANDON_AFTER_BUDGETS;

    // First query goes out and never settles.
    let pending = probe.run();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    // Past the limit it is abandoned; the fresh one never settles either.
    await vi.advanceTimersByTimeAsync(limit);
    run.mockImplementation(() => new Promise<void>(() => undefined));
    pending = probe.run();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal((await pending).checks.database!.reason, "timeout");
    assert.equal(run.mock.calls.length, 2);

    // However long that lasts, no third is started while both are out.
    await vi.advanceTimersByTimeAsync(limit * 10);
    assert.equal((await probe.run()).checks.database!.reason, "timeout");
    assert.equal(run.mock.calls.length, 2);

    // Once the abandoned one settles, its slot frees and a probe can run.
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    run.mockImplementation(async () => undefined);
    const recovered = await probe.run();
    assert.equal(run.mock.calls.length, 3);
    assert.equal(recovered.status, "ok");
  } finally {
    vi.useRealTimers();
  }
});
