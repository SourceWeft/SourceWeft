import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { runHealthCommand } from "../launch/health";
import {
  checkServiceHeartbeat,
  HEARTBEAT_STALE_MS,
  heartbeatFilePath,
  startServiceHeartbeat,
} from "./service-heartbeat";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "sourceweft-heartbeat-test-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

test("a healthy process renews its heartbeat and a fresh one passes", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const heartbeat = startServiceHeartbeat({
    directory,
    intervalMs: 10_000,
    isHealthy: () => true,
    service: "worker",
  });
  try {
    vi.advanceTimersByTime(50_000);
    const result = checkServiceHeartbeat({
      directory,
      now: Date.now(),
      service: "worker",
    });
    assert.equal(result.healthy, true);
    assert.equal(result.reason, "worker heartbeat 0s old");
  } finally {
    heartbeat.stop();
  }
});

test("a process that stops judging itself healthy goes stale", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  let healthy = true;
  const heartbeat = startServiceHeartbeat({
    directory,
    intervalMs: 10_000,
    isHealthy: () => healthy,
    service: "scheduler",
  });
  try {
    healthy = false;
    vi.advanceTimersByTime(HEARTBEAT_STALE_MS + 10_000);
    const result = checkServiceHeartbeat({
      directory,
      now: Date.now(),
      service: "scheduler",
    });
    assert.equal(result.healthy, false);
    assert.equal(result.reason, "scheduler heartbeat is 70s old (limit 60s)");
  } finally {
    heartbeat.stop();
  }
});

test("stopping removes the heartbeat, so a process shutting down is unhealthy", () => {
  const heartbeat = startServiceHeartbeat({
    directory,
    isHealthy: () => true,
    service: "worker",
  });
  assert.equal(existsSync(heartbeatFilePath("worker", directory)), true);
  heartbeat.stop();
  assert.equal(existsSync(heartbeatFilePath("worker", directory)), false);
  assert.deepEqual(checkServiceHeartbeat({ directory, service: "worker" }), {
    healthy: false,
    reason: "worker has no heartbeat",
  });
});

test("an unreadable heartbeat fails", () => {
  writeFileSync(heartbeatFilePath("worker", directory), "not a time");
  assert.deepEqual(checkServiceHeartbeat({ directory, service: "worker" }), {
    healthy: false,
    reason: "worker heartbeat is unreadable",
  });
});

test("the health command exits 0 only for a fresh heartbeat of a known service", () => {
  writeFileSync(heartbeatFilePath("worker", directory), String(1_000_000));
  assert.deepEqual(runHealthCommand("worker", { directory, now: 1_005_000 }), {
    code: 0,
    message: "worker heartbeat 5s old",
  });
  assert.equal(
    runHealthCommand("worker", { directory, now: 1_000_000 + 61_000 }).code,
    1,
  );
  assert.deepEqual(runHealthCommand("scheduler", { directory }), {
    code: 1,
    message: "scheduler has no heartbeat",
  });
  assert.deepEqual(runHealthCommand("api", { directory }), {
    code: 1,
    message:
      'Unknown health check service "api"; expected one of: worker, scheduler.',
  });
});
