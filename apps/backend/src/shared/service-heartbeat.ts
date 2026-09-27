import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Liveness for backend processes without an HTTP endpoint (worker, scheduler).
 * While the process judges itself healthy it writes a timestamp to a file in
 * the container's temp directory; a separate health command reads it. The
 * process decides what healthy means; the command only asks whether it said so
 * recently. A dependency outage should not fail liveness — a restart would not
 * fix it — so the callers check their own progress, not Redis or Postgres.
 */

export const HEARTBEAT_SERVICES = ["worker", "scheduler"] as const;
export type HeartbeatService = (typeof HEARTBEAT_SERVICES)[number];

/** How often a healthy process renews its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** A heartbeat older than this means the process is not healthy. */
export const HEARTBEAT_STALE_MS = 60_000;

export function heartbeatFilePath(
  service: HeartbeatService,
  directory = tmpdir(),
) {
  return path.join(directory, `sourceweft-${service}.heartbeat`);
}

/**
 * Renews `service`'s heartbeat every `intervalMs` while `isHealthy()` holds.
 * `stop()` removes it, so a process that is shutting down reports unhealthy.
 */
export function startServiceHeartbeat(input: {
  directory?: string;
  intervalMs?: number;
  isHealthy: () => boolean;
  now?: () => number;
  service: HeartbeatService;
}) {
  const file = heartbeatFilePath(input.service, input.directory);
  const now = input.now ?? Date.now;
  const beat = () => {
    if (!input.isHealthy()) return;
    // Write then rename, so a reader never sees a half-written file.
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, String(now()));
    renameSync(temporary, file);
  };
  beat();
  const timer = setInterval(beat, input.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      rmSync(file, { force: true });
    },
  };
}

export function parseHeartbeatService(
  value: string | undefined,
): HeartbeatService {
  const service = HEARTBEAT_SERVICES.find((candidate) => candidate === value);
  if (!service) {
    throw new Error(
      `Unknown health check service "${value ?? ""}"; expected one of: ${HEARTBEAT_SERVICES.join(", ")}.`,
    );
  }
  return service;
}

/** Whether `service` renewed its heartbeat within `staleMs`, and why not. */
export function checkServiceHeartbeat(input: {
  directory?: string;
  now?: number;
  service: HeartbeatService;
  staleMs?: number;
}): { healthy: boolean; reason: string } {
  const file = heartbeatFilePath(input.service, input.directory);
  let written: number;
  try {
    written = Number(readFileSync(file, "utf8"));
  } catch {
    return { healthy: false, reason: `${input.service} has no heartbeat` };
  }
  if (!Number.isFinite(written)) {
    return {
      healthy: false,
      reason: `${input.service} heartbeat is unreadable`,
    };
  }
  const ageMs = (input.now ?? Date.now()) - written;
  const staleMs = input.staleMs ?? HEARTBEAT_STALE_MS;
  return ageMs <= staleMs
    ? {
        healthy: true,
        reason: `${input.service} heartbeat ${Math.round(ageMs / 1000)}s old`,
      }
    : {
        healthy: false,
        reason: `${input.service} heartbeat is ${Math.round(ageMs / 1000)}s old (limit ${Math.round(staleMs / 1000)}s)`,
      };
}
