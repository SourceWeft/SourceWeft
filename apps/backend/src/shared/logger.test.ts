import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { logger } from "./logger";

const originalNodeEnv = process.env.NODE_ENV;
const originalConsoleLog = console.log;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  console.log = originalConsoleLog;
});

function captureConsoleLog() {
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    calls.push(args);
  };
  return calls;
}

test("production logger writes metadata on a single line", () => {
  process.env.NODE_ENV = "production";
  const calls = captureConsoleLog();

  logger.info("Job completed", {
    jobId: "source_parse_df4d6e10_1_3",
    type: "source-parse-poll",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 1);

  const line = String(calls[0]?.[0]);
  assert.match(
    line,
    /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[INFO\] Job completed /,
  );
  assert.equal(line.includes("\n"), false);
  assert.match(line, /"jobId":"source_parse_df4d6e10_1_3"/);
  assert.match(line, /"type":"source-parse-poll"/);
});

test("non-production logger keeps metadata as a console argument", () => {
  process.env.NODE_ENV = "development";
  const calls = captureConsoleLog();
  const meta = { jobId: "job-1", type: "thread-chat-run" };

  logger.info("Job completed", meta);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 2);
  assert.match(String(calls[0]?.[0]), /\[INFO\] Job completed$/);
  assert.equal(calls[0]?.[1], meta);
});

test("production logger safely serializes complex metadata", () => {
  process.env.NODE_ENV = "production";
  const calls = captureConsoleLog();
  const meta: Record<string, unknown> = {
    count: 1n,
    error: new Error("failed"),
  };
  meta.self = meta;

  assert.doesNotThrow(() => logger.error("Job failed", meta));

  const line = String(calls[0]?.[0]);
  assert.equal(line.includes("\n"), false);
  assert.match(line, /"count":"1"/);
  assert.match(line, /"message":"failed"/);
  assert.match(line, /"self":"\[Circular\]"/);
});
