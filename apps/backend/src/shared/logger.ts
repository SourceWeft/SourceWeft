import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

const base = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        },
      }),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "meta.headers.authorization",
      "meta.headers.cookie",
      // Connector `credential` bodies (POST /connectors, POST /connectors/check,
      // PUT /connectors/:id/credential). No code path logs these, but redact
      // them as a last line of defence so a username or app password can never
      // reach a log line even if a future caller logs a request body.
      "credential",
      "credential.secret",
      "credential.username",
      "secret",
      "req.body.credential",
      "req.body.secret",
      "body.credential",
      "body.secret",
      // Credential login-flow server-side secrets: the opaque `pending` blob the
      // backend stores encrypted (poll endpoint + token) and the one-time app
      // password a provider hands back. Same last-line-of-defence rule — no code
      // path logs these either.
      "pending",
      "pollToken",
      "pending.pollToken",
      "appPassword",
      "req.body.pending",
      "req.body.pollToken",
      "req.body.appPassword",
      "body.pending",
      "body.pollToken",
      "body.appPassword",
    ],
    censor: "[REDACTED]",
  },
});

type Meta = Record<string, unknown> | undefined;

/**
 * Backward-compatible logger wrapping pino.
 *
 * Call signature: `logger.info("message")` or `logger.info("message", { key: val })`
 *
 * In production, emits structured JSON to stdout (compatible with
 * CloudWatch, Loki, Datadog, etc.).  In development, uses pino-pretty
 * for human-readable colourised output.
 */
export const logger = {
  debug: (message: string, meta?: Meta) => {
    if (meta) {
      base.debug(meta, message);
    } else {
      base.debug(message);
    }
  },

  info: (message: string, meta?: Meta) => {
    if (meta) {
      base.info(meta, message);
    } else {
      base.info(message);
    }
  },

  warn: (message: string, meta?: Meta) => {
    if (meta) {
      base.warn(meta, message);
    } else {
      base.warn(message);
    }
  },

  error: (message: string, meta?: Meta) => {
    if (meta) {
      base.error(meta, message);
    } else {
      base.error(message);
    }
  },
};
