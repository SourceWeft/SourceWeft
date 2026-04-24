import assert from "node:assert/strict";
import test from "node:test";
import { redactRecord, logRequestStart } from "../src/middleware/logging";
import {
  buildTracingHeaders,
  buildTracingMetadata,
} from "../src/middleware/tracing";

test("buildTracingMetadata merges defaults, request metadata, and options", () => {
  const metadata = buildTracingMetadata(
    {
      team_id: "team_from_request",
      feature: "chat",
    },
    {
      traceId: "trace_1",
      tags: ["prod", "chat"],
      metadata: {
        feature: "override",
        request_id: "req_1",
      },
    },
    {
      team_id: "team_default",
      workspace_id: "workspace_default",
    },
  );

  assert.deepEqual(metadata, {
    team_id: "team_from_request",
    workspace_id: "workspace_default",
    feature: "override",
    request_id: "req_1",
    trace_id: "trace_1",
    tags: ["prod", "chat"],
  });
});

test("buildTracingHeaders only includes trace header when present", () => {
  assert.deepEqual(buildTracingHeaders(), {});
  assert.deepEqual(buildTracingHeaders({ traceId: "trace_1" }), {
    "X-Trace-Id": "trace_1",
  });
});

test("redactRecord removes secrets and masks nested string values", () => {
  const redacted = redactRecord({
    authorization: "Bearer super-secret-token",
    apiKey: "secret-key",
    nested: {
      sessionToken: "1234567890",
      note: "abcdefghij",
    },
    tags: ["short", "long-enough-value"],
  });

  assert.deepEqual(redacted, {
    authorization: "***",
    apiKey: "***",
    nested: {
      sessionToken: "***",
      note: "ab***ij",
    },
    tags: ["***", "lo***ue"],
  });
});

test("logRequestStart sends redacted payloads to debug logger", () => {
  const calls: Array<{ message: string; data?: Record<string, unknown> }> = [];

  logRequestStart(
    {
      debug(message, data) {
        calls.push({ message, data });
      },
    },
    "model-gateway.request.start",
    {
      authorization: "Bearer super-secret-token",
      nested: {
        token: "1234567890",
        label: "abcdefghij",
      },
    },
  );

  assert.deepEqual(calls, [
    {
      message: "model-gateway.request.start",
      data: {
        authorization: "***",
        nested: {
          token: "***",
          label: "ab***ij",
        },
      },
    },
  ]);
});
