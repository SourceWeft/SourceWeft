import { expect, test } from "vitest";
import {
  localDeviceReplySchema,
  localInvocationFailure,
  persistLocalFailureCode,
} from "./invocation-reply";

test("optional native failure code survives protocol and existing JSONB without text parsing", () => {
  const reply = localDeviceReplySchema.parse({
    type: "result",
    id: "call",
    ok: false,
    error: "localized missing description",
    errorCode: "FILE_NOT_FOUND",
  });
  if (reply.type !== "result") throw new Error("wrong reply");
  const result = persistLocalFailureCode(reply);
  const error = localInvocationFailure({
    action: "file.binary.begin",
    status: "failed",
    error: reply.error,
    result,
  });
  expect(error.code).toBe("FILE_NOT_FOUND");
  expect(error.statusCode).toBe(404);
});

test("old hosts and unrelated error states remain fail closed regardless of English text", () => {
  const old = localDeviceReplySchema.parse({
    type: "result",
    id: "old",
    ok: false,
    error: "FILE_NOT_FOUND: ENOENT no such file",
  });
  if (old.type !== "result") throw new Error("wrong reply");
  expect(
    localInvocationFailure({
      action: "file.binary.begin",
      status: "failed",
      error: old.error,
      result: persistLocalFailureCode(old),
    }).code,
  ).toBe("LOCAL_EXECUTION_FAILED");
  for (const [action, status, code] of [
    ["file.binary.begin", "failed", "FILE_ACCESS_DENIED"],
    ["file.binary.begin", "cancelled", "FILE_NOT_FOUND"],
    ["file.binary.chunk", "failed", "FILE_NOT_FOUND"],
    ["file.write", "failed", "FILE_NOT_FOUND"],
  ]) {
    expect(
      localInvocationFailure({
        action: action!,
        status: status!,
        result: persistLocalFailureCode({ ok: false, errorCode: code }),
      }).code,
    ).toBe(`LOCAL_EXECUTION_${status!.toUpperCase()}`);
  }
  expect(
    persistLocalFailureCode({
      ok: false,
      result: { sourceweftLocalErrorCode: "FILE_NOT_FOUND" },
    }),
  ).toBeNull();
});

test("network.ask is part of the closed device protocol and nothing looser is accepted", () => {
  const ask = {
    type: "network.ask",
    id: "call",
    askId: "ask-1",
    host: "example.com",
    port: 443,
  };
  expect(localDeviceReplySchema.parse(ask)).toEqual(ask);
  for (const bad of [
    { ...ask, port: 0 },
    { ...ask, port: 65536 },
    { ...ask, port: 443.5 },
    { ...ask, port: "443" },
    { ...ask, host: "" },
    { ...ask, host: "h".repeat(256) },
    { ...ask, askId: "" },
    { ...ask, askId: "a".repeat(129) },
    { type: "network.ask", id: "call", askId: "a", host: "x" },
    { type: "network.decision", askId: "a", allow: true },
  ])
    expect(localDeviceReplySchema.safeParse(bad).success).toBe(false);
});
