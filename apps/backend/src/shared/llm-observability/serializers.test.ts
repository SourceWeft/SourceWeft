import assert from "node:assert/strict";
import test from "node:test";
import { serializeError, toJsonSafe } from "./serializers";

test("serializes dates and bigint values", () => {
  const output = toJsonSafe({
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    count: 123n,
  }) as Record<string, unknown>;

  assert.equal(output.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(output.count, "123");
});

test("serializes circular references safely", () => {
  const input: Record<string, unknown> = { name: "root" };
  input.self = input;

  const output = toJsonSafe(input) as Record<string, unknown>;

  assert.equal(output.name, "root");
  assert.equal(output.self, "[Circular]");
});

test("serializes errors with message and code", () => {
  const error = new Error("failed") as Error & { code?: string };
  error.code = "BAD_REQUEST";

  const output = serializeError(error);

  assert.equal(output.message, "failed");
  assert.equal(output.code, "BAD_REQUEST");
  assert.equal(output.name, "Error");
});
