import {
  checkServiceHeartbeat,
  parseHeartbeatService,
} from "../shared/service-heartbeat";

/**
 * `launch.js health <worker|scheduler>`: a container health check. Exit code 0
 * when the service renewed its heartbeat recently, 1 otherwise, with the
 * reason on one line. Reads only the local heartbeat file — no database,
 * network or configuration — so it is cheap to run every few seconds.
 */
export function runHealthCommand(
  service: string | undefined,
  options: { directory?: string; now?: number } = {},
): { code: number; message: string } {
  let checked;
  try {
    checked = checkServiceHeartbeat({
      ...options,
      service: parseHeartbeatService(service),
    });
  } catch (error) {
    return {
      code: 1,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { code: checked.healthy ? 0 : 1, message: checked.reason };
}
