const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../shared/logger", () => ({
  logger: {
    debug: loggerMocks.debug,
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
  },
}));

import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { connectorToolResult } from "./agent-tool-errors";
import { ConnectorError } from "./errors";

test("a package connector error's message reaches the agent", async () => {
  const payload = await connectorToolResult(async () => {
    throw {
      statusCode: 409,
      code: "GITHUB_NOTHING_SELECTED",
      message:
        "No repositories are selected for this GitHub connector. Ask the user to choose repositories in the connector settings.",
    };
  });

  assert.deepEqual(payload, {
    type: "connector_tool_error",
    code: "GITHUB_NOTHING_SELECTED",
    message:
      "No repositories are selected for this GitHub connector. Ask the user to choose repositories in the connector settings.",
    statusCode: 409,
  });
});

test("a class instance from a connector package behaves the same", async () => {
  class FakeAdapterError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.name = "FakeAdapterError";
      this.statusCode = statusCode;
      this.code = code;
    }
  }

  const payload = await connectorToolResult(async () => {
    throw new FakeAdapterError(
      429,
      "GITHUB_RATE_LIMITED",
      "Rate limited. Try again later.",
    );
  });

  assert.deepEqual(payload, {
    type: "connector_tool_error",
    code: "GITHUB_RATE_LIMITED",
    message: "Rate limited. Try again later.",
    statusCode: 429,
  });
});

test("an unexpected error keeps the generic message", async () => {
  const payloadA = await connectorToolResult(async () => {
    throw new TypeError("Cannot read properties of undefined (reading 'token')");
  });
  const payloadB = await connectorToolResult(async () => {
    throw new Error("select * from secrets failed");
  });

  assert.deepEqual(payloadA, {
    type: "connector_tool_error",
    code: "CONNECTOR_OPERATION_FAILED",
    message: "Connector tool failed. Check backend logs for details.",
    statusCode: 500,
  });
  assert.deepEqual(payloadB, {
    type: "connector_tool_error",
    code: "CONNECTOR_OPERATION_FAILED",
    message: "Connector tool failed. Check backend logs for details.",
    statusCode: 500,
  });

  const serializedA = JSON.stringify(payloadA);
  const serializedB = JSON.stringify(payloadB);
  assert.equal(
    serializedA.includes("Cannot read properties of undefined"),
    false,
  );
  assert.equal(serializedB.includes("select * from secrets failed"), false);
});

test("a long message is cut to 500 characters", async () => {
  const longMessage = "x".repeat(2000);
  const payload = await connectorToolResult(async () => {
    throw { statusCode: 400, code: "GITHUB_BAD_REQUEST", message: longMessage };
  });

  const message = (payload as { message: string }).message;
  assert.equal(message.length, 500);
  assert.equal(message.endsWith("…"), true);
});

test("control characters are removed from the message", async () => {
  const payload = await connectorToolResult(async () => {
    throw {
      statusCode: 400,
      code: "GITHUB_BAD_REQUEST",
      message: "bad\x00request\x1Fwith\x7Fcontrol\nchars",
    };
  });

  const message = (payload as { message: string }).message;
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\x00-\x1F\x7F]/.test(message), false);
});

test("retryAfterSeconds is forwarded from details", async () => {
  const withRetry = (details: Record<string, unknown>) =>
    connectorToolResult(async () => {
      throw {
        statusCode: 429,
        code: "GITHUB_RATE_LIMITED",
        message: "Rate limited.",
        details,
      };
    });

  const rounded = await withRetry({ retryAfterSeconds: 37.2 });
  assert.equal((rounded as { retryAfterSeconds?: number }).retryAfterSeconds, 38);

  const zero = await withRetry({ retryAfterSeconds: 0 });
  assert.equal("retryAfterSeconds" in (zero as object), false);

  const negative = await withRetry({ retryAfterSeconds: -5 });
  assert.equal("retryAfterSeconds" in (negative as object), false);

  const stringValue = await withRetry({ retryAfterSeconds: "60" });
  assert.equal("retryAfterSeconds" in (stringValue as object), false);

  const missing = await withRetry({});
  assert.equal("retryAfterSeconds" in (missing as object), false);

  const huge = await withRetry({ retryAfterSeconds: 999999 });
  assert.equal((huge as { retryAfterSeconds?: number }).retryAfterSeconds, 86400);
});

test("the platform's own ConnectorError is unchanged", async () => {
  const payload = await connectorToolResult(async () => {
    throw new ConnectorError(502, "GITHUB_UNAVAILABLE", "provider is down", {
      sourceRef: undefined,
      recoverable: true,
    });
  });

  assert.deepEqual(payload, {
    type: "connector_tool_error",
    code: "GITHUB_UNAVAILABLE",
    message: "provider is down",
    statusCode: 502,
    recoverable: true,
  });
});

test("the message is still not logged for a read action", async () => {
  loggerMocks.debug.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  loggerMocks.error.mockClear();

  await connectorToolResult(
    async () => {
      throw {
        statusCode: 409,
        code: "GITHUB_NOTHING_SELECTED",
        message: "No repositories are selected for this secret-laden connector.",
      };
    },
    { omitResponseContent: true },
  );

  const everyCall = JSON.stringify([
    loggerMocks.debug.mock.calls,
    loggerMocks.info.mock.calls,
    loggerMocks.warn.mock.calls,
    loggerMocks.error.mock.calls,
  ]);
  assert.equal(
    everyCall.includes("No repositories are selected for this secret-laden connector"),
    false,
  );

  const errorCall = loggerMocks.error.mock.calls.find(
    (entry) => entry[0] === "Connector agent tool failed",
  );
  assert.ok(errorCall);
  const errorMeta = errorCall![1] as Record<string, unknown>;
  assert.equal(errorMeta.code, "GITHUB_NOTHING_SELECTED");
  assert.equal("error" in errorMeta, false);
  assert.equal("stack" in errorMeta, false);
});
