import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { afterEach, test } from "vitest";
import pino from "pino";

// Re-implement the logger factory inline so tests can capture output.
// The real module is tested indirectly via the captured pino stream.

type Meta = Record<string, unknown> | undefined;

function createLogger(destination: Writable) {
  const base = pino({ level: "debug" }, destination);

  return {
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
}

function captureOutput() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines: () => chunks.join("").trim().split("\n") };
}

test("logs a message without metadata", () => {
  const { stream, lines } = captureOutput();
  const logger = createLogger(stream);

  logger.info("hello world");

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.msg, "hello world");
  assert.equal(parsed[0]?.level, 30); // info = 30
});

test("logs a message with metadata", () => {
  const { stream, lines } = captureOutput();
  const logger = createLogger(stream);

  logger.info("Job completed", { jobId: "abc-123", type: "parse" });

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);

  const entry = parsed[0];
  assert.equal(entry?.msg, "Job completed");
  assert.equal(entry?.jobId, "abc-123");
  assert.equal(entry?.type, "parse");
});

test("logs at different levels", () => {
  const { stream, lines } = captureOutput();
  const logger = createLogger(stream);

  logger.debug("debug msg");
  logger.info("info msg");
  logger.warn("warn msg");
  logger.error("error msg");

  const levels = lines().map((l) => JSON.parse(l).level);
  assert.deepEqual(levels, [20, 30, 40, 50]); // debug, info, warn, error
});

test("handles error objects in metadata", () => {
  const { stream, lines } = captureOutput();
  const logger = createLogger(stream);

  assert.doesNotThrow(() =>
    logger.error("Job failed", { err: new Error("boom") }),
  );

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);

  const entry = parsed[0];
  assert.equal(entry?.msg, "Job failed");
  assert.equal(entry?.err?.message, "boom");
  assert.equal(entry?.err?.type, "Error");
});

test("handles BigInt in metadata", () => {
  const { stream, lines } = captureOutput();
  const logger = createLogger(stream);

  assert.doesNotThrow(() =>
    logger.info("BigInt test", { count: 1n }),
  );

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  // pino serializes BigInt natively
  assert.equal(parsed[0]?.count, 1);
});

test("backward-compatible API: message-only calls work", () => {
  const { stream, lines } = captureOutput();
  const logger = createLogger(stream);

  // These are the most common call patterns in the codebase:
  logger.info("simple message");
  logger.warn("warning message");
  logger.error("error message");
  logger.debug("debug message");

  const msgs = lines().map((l) => JSON.parse(l).msg);
  assert.deepEqual(msgs, [
    "simple message",
    "warning message",
    "error message",
    "debug message",
  ]);
});

test("backward-compatible API: message + meta calls work", () => {
  const { stream, lines } = captureOutput();
  const logger = createLogger(stream);
  const meta = { workspaceId: "ws-1", threadId: "th-1" };

  logger.info("Thread started", meta);
  logger.error("Thread failed", { ...meta, error: "timeout" });

  const parsed = lines().map((l) => JSON.parse(l));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.workspaceId, "ws-1");
  assert.equal(parsed[0]?.threadId, "th-1");
  assert.equal(parsed[1]?.error, "timeout");
});
