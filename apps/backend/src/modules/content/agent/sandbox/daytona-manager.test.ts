import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveSandboxToolOperationReplay, stableSandboxRequestJson } from "./daytona-manager";

test("stableSandboxRequestJson normalizes object key order", () => {
  assert.equal(
    stableSandboxRequestJson({ b: 2, a: { d: 4, c: 3 } }),
    stableSandboxRequestJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("stableSandboxRequestJson distinguishes different replay requests", () => {
  assert.notEqual(
    stableSandboxRequestJson({ command: "pwd" }),
    stableSandboxRequestJson({ command: "rm -rf /workspace/work" }),
  );
});

test("failed sandbox operation requires explicit retry request change", () => {
  const existing = {
    status: "failed" as const,
    requestJsonRedacted: { command: "pwd" },
    resultJsonRedacted: { error: "provider failed" },
  };

  const sameRequest = resolveSandboxToolOperationReplay({
    operationType: "execute",
    existing,
    request: { command: "pwd" },
  });
  const retryRequest = resolveSandboxToolOperationReplay({
    operationType: "execute",
    existing,
    request: { command: "pwd", retryNonce: "retry-1" },
  });

  assert.equal(sameRequest.kind, "error");
  assert.match(sameRequest.kind === "error" ? sameRequest.message : "", /SANDBOX_OPERATION_FAILED_RETRY_REQUIRED/);
  assert.equal(retryRequest.kind, "proceed");
});
