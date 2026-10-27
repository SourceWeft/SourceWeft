import { describe, expect, test } from "vitest";
import {
  deviceStatusColumns,
  localDeviceReplySchema,
  SANDBOX_REMEDIES,
  SANDBOX_SETUP_CODES,
  serializeDeviceSandbox,
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

const status = {
  type: "status",
  platform: "linux",
  arch: "x64",
  shell: "bash",
  protocolVersion: 3,
  sandbox: {
    state: "needsSetup",
    code: "bwrapMissing",
    reason: "bubblewrap is not installed",
    remedy: "privilegedSetup",
  },
  capabilities: ["sandbox", "files"],
};

describe("device status message", () => {
  test("accepts a full report and a minimal ready report", () => {
    expect(localDeviceReplySchema.parse(status)).toEqual(status);
    const minimal = {
      type: "status",
      platform: "macos",
      arch: "arm64",
      shell: "zsh",
      sandbox: { state: "ready" },
      capabilities: [],
    };
    expect(localDeviceReplySchema.parse(minimal)).toEqual(minimal);
  });

  test("every SetupCode and Remedy of the wire contract is accepted", () => {
    expect([...SANDBOX_SETUP_CODES]).toEqual([
      "bundleMissing",
      "bundleStale",
      "bundleNewer",
      "bundleInvalid",
      "bwrapMissing",
      "userNamespaceRestricted",
      "sandboxFailed",
      "installing",
      "windowsNotInstalled",
      "windowsSetupOutdated",
    ]);
    expect([...SANDBOX_REMEDIES]).toEqual([
      "downloadRuntime",
      "updateApp",
      "reinstallPackage",
      "privilegedSetup",
      "elevatedSetup",
      "none",
    ]);
    for (const code of SANDBOX_SETUP_CODES)
      for (const remedy of SANDBOX_REMEDIES)
        expect(
          localDeviceReplySchema.safeParse({
            ...status,
            sandbox: { state: "needsSetup", code, remedy, reason: "why" },
          }).success,
        ).toBe(true);
  });

  test("accepts a Windows host that needs its elevated setup", () => {
    const windows = {
      type: "status",
      platform: "windows",
      arch: "x64",
      shell: "bash",
      sandbox: {
        state: "needsSetup",
        code: "windowsNotInstalled",
        reason: "The Windows sandbox is not installed.",
        remedy: "elevatedSetup",
      },
      capabilities: ["sandbox"],
    };
    expect(localDeviceReplySchema.parse(windows)).toEqual(windows);
    expect(
      localDeviceReplySchema.parse({
        ...windows,
        sandbox: { ...windows.sandbox, code: "windowsSetupOutdated" },
      }),
    ).toMatchObject({ sandbox: { code: "windowsSetupOutdated" } });
  });

  test.each([
    ["platform", { platform: "freebsd" }],
    ["arch", { arch: "ia32" }],
    ["empty shell", { shell: "" }],
    ["shell with a path", { shell: "/bin/bash" }],
    ["shell with a space", { shell: "my shell" }],
    ["long shell", { shell: "a".repeat(65) }],
    ["fractional protocolVersion", { protocolVersion: 1.5 }],
    ["sandbox state", { sandbox: { state: "broken" } }],
    ["sandbox code", { sandbox: { ...status.sandbox, code: "nope" } }],
    ["sandbox remedy", { sandbox: { ...status.sandbox, remedy: "nope" } }],
    [
      "long reason",
      { sandbox: { ...status.sandbox, reason: "x".repeat(1001) } },
    ],
    ["ready with a code", { sandbox: { state: "ready", code: "bundleStale" } }],
    ["ready with a remedy", { sandbox: { state: "ready", remedy: "none" } }],
    ["ready with a reason", { sandbox: { state: "ready", reason: "why" } }],
    [
      "needsSetup without a code",
      { sandbox: { state: "needsSetup", remedy: "none", reason: "why" } },
    ],
    [
      "needsSetup without a remedy",
      {
        sandbox: { state: "needsSetup", code: "bundleStale", reason: "why" },
      },
    ],
    [
      "needsSetup without a reason",
      {
        sandbox: { state: "needsSetup", code: "bundleStale", remedy: "none" },
      },
    ],
    ["bare needsSetup", { sandbox: { state: "needsSetup" } }],
    [
      "unsupported with a code",
      { sandbox: { state: "unsupported", code: "bundleStale" } },
    ],
    [
      "unsupported with a remedy",
      { sandbox: { state: "unsupported", remedy: "none" } },
    ],
    ["missing sandbox", { sandbox: undefined }],
    ["too many capabilities", { capabilities: Array(33).fill("a") }],
    ["long capability", { capabilities: ["a".repeat(65)] }],
    ["empty capability", { capabilities: [""] }],
    ["non-string capability", { capabilities: [1] }],
  ])("rejects an invalid %s", (_name, patch) => {
    expect(
      localDeviceReplySchema.safeParse({ ...status, ...patch }).success,
    ).toBe(false);
  });

  test("unsupported needs no detail and may carry a reason", () => {
    for (const sandbox of [
      { state: "unsupported" },
      { state: "unsupported", reason: "no sandbox on this OS" },
    ])
      expect(
        localDeviceReplySchema.safeParse({ ...status, sandbox }).success,
      ).toBe(true);
  });

  test("unknown keys are stripped so newer hosts stay compatible", () => {
    const parsed = localDeviceReplySchema.parse({
      ...status,
      osVersion: "26.1",
      sandbox: { ...status.sandbox, extra: true },
    });
    expect(parsed).toEqual(status);
  });

  test("accepts a 1000 character reason and 32 capabilities", () => {
    expect(
      localDeviceReplySchema.safeParse({
        ...status,
        sandbox: { ...status.sandbox, reason: "x".repeat(1000) },
        capabilities: Array(32).fill("a"),
      }).success,
    ).toBe(true);
  });

  test("column mapping and serialisation round-trip, with null before any report", () => {
    const now = new Date("2026-10-25T00:00:00Z");
    const message = localDeviceReplySchema.parse(status);
    if (message.type !== "status") throw new Error("wrong reply");
    const columns = deviceStatusColumns(message, now);
    expect(columns).toEqual({
      platform: "linux",
      arch: "x64",
      shell: "bash",
      sandboxState: "needsSetup",
      sandboxCode: "bwrapMissing",
      sandboxReason: "bubblewrap is not installed",
      sandboxRemedy: "privilegedSetup",
      capabilities: ["sandbox", "files"],
      statusReportedAt: now,
    });
    expect(serializeDeviceSandbox(columns)).toEqual(status.sandbox);
    const ready = deviceStatusColumns(
      {
        ...message,
        sandbox: { state: "ready" },
      },
      now,
    );
    expect(ready.sandboxCode).toBeNull();
    expect(serializeDeviceSandbox(ready)).toEqual({ state: "ready" });
    expect(
      serializeDeviceSandbox({
        sandboxState: null,
        sandboxCode: null,
        sandboxReason: null,
        sandboxRemedy: null,
      }),
    ).toBeNull();
  });
});
