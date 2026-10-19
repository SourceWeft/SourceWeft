import type { ModelGatewayConfig } from "@sourceweft/model-gateway";
import { logger as sharedLogger } from "../logger";

type GatewayLogger = NonNullable<ModelGatewayConfig["logger"]>;

/** The shared pino wrapper's call shape: `(message, meta?)`. */
export type StructuredLogger = {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
};

// The gateway only reports codes, attempt counts, providers and models, never
// request material. This is a last line of defence should a future log site
// spread a target or header object into its fields.
const CREDENTIAL_KEY =
  /(api[-_]?key|authorization|cookie|password|secret|token)$/i;

function scrubCredentials(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubCredentials(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = CREDENTIAL_KEY.test(key)
      ? "[REDACTED]"
      : scrubCredentials(item, depth + 1);
  }
  return out;
}

/**
 * Adapts the backend's structured logger to the gateway's `GatewayLogger`, so
 * `model-gateway.retry`, `model-gateway.failover*` and the other package log
 * lines reach the API and worker logs with their fields as pino properties
 * rather than being dropped (the gateway logs nothing without a logger).
 */
export function createGatewayLogger(
  target: StructuredLogger = sharedLogger,
): GatewayLogger {
  const forward =
    (level: keyof StructuredLogger) =>
    (message: string, data?: Record<string, unknown>) => {
      target[level](
        message,
        data === undefined
          ? undefined
          : (scrubCredentials(data) as Record<string, unknown>),
      );
    };
  return {
    debug: forward("debug"),
    info: forward("info"),
    warn: forward("warn"),
    error: forward("error"),
  };
}
