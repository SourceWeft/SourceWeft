import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock("../../shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.info,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  logAuthSessionCreated,
  logAuthUserCreated,
  logDesktopHandoffCompleted,
  resolveBetterAuthLogLevel,
} from "./auth-activity-log";

const USER_ID = "user_0199cd4f7b1e7c3a9f0e";
const EMAIL = "person@example.com";
const TOKEN = "ott_super_secret_token_value";

function fieldsOf(call: unknown[] | undefined) {
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

function assertSafe(fields: Record<string, unknown>) {
  const serialized = JSON.stringify(fields);
  assert.ok(!serialized.includes(USER_ID), "full user id leaked");
  assert.ok(!serialized.includes(EMAIL), "email leaked");
  assert.ok(!serialized.includes(TOKEN), "token leaked");
}

class FakeStateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StateError";
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("auth.user_created logs only a truncated user id", () => {
  logAuthUserCreated({ id: USER_ID, email: EMAIL } as { id: string });

  assert.equal(mocks.info.mock.calls[0]?.[0], "auth.user_created");
  const fields = fieldsOf(mocks.info.mock.calls[0]);
  assert.deepEqual(fields, { userId: "user_019" });
  assertSafe(fields);
});

test("auth.session_created logs the endpoint template and truncated user id", () => {
  logAuthSessionCreated(
    { userId: USER_ID, token: TOKEN } as { userId: string },
    { path: "/callback/:id" },
  );

  assert.equal(mocks.info.mock.calls[0]?.[0], "auth.session_created");
  const fields = fieldsOf(mocks.info.mock.calls[0]);
  assert.deepEqual(fields, { userId: "user_019", via: "/callback/:id" });
  assertSafe(fields);
});

test("auth.session_created tolerates a missing endpoint context", () => {
  logAuthSessionCreated({ userId: USER_ID }, null);

  assert.deepEqual(fieldsOf(mocks.info.mock.calls[0]), {
    userId: "user_019",
    via: null,
  });
});

test("auth.desktop_handoff_completed reads the user id from the session envelope only", () => {
  logDesktopHandoffCompleted({
    session: { token: TOKEN, userId: USER_ID },
    user: { id: USER_ID, email: EMAIL },
  });

  assert.equal(mocks.info.mock.calls[0]?.[0], "auth.desktop_handoff_completed");
  const fields = fieldsOf(mocks.info.mock.calls[0]);
  assert.deepEqual(fields, { userId: "user_019" });
  assertSafe(fields);

  logDesktopHandoffCompleted(undefined);
  assert.deepEqual(fieldsOf(mocks.info.mock.calls[1]), { userId: null });
});

test("a replayed OAuth callback (state_mismatch) maps to warn with its code", () => {
  const resolved = resolveBetterAuthLogLevel({
    level: "error",
    message: "Failed to parse state",
    args: [
      new FakeStateError("State mismatch: verification not found", "state_mismatch", {
        state: "oauth-state-value",
      }),
    ],
  });

  assert.deepEqual(resolved, { level: "warn", code: "state_mismatch" });
});

test("state_security_mismatch stays at error", () => {
  const resolved = resolveBetterAuthLogLevel({
    level: "error",
    message: "Failed to parse state",
    args: [
      new FakeStateError(
        "State mismatch: OAuth state parameter does not match stored state",
        "state_security_mismatch",
        { state: "oauth-state-value" },
      ),
    ],
  });

  assert.deepEqual(resolved, { level: "error", code: "state_security_mismatch" });
});

test("other Better Auth messages and levels pass through unchanged", () => {
  assert.deepEqual(
    resolveBetterAuthLogLevel({
      level: "error",
      message: "Failed to parse state",
      args: [new Error("no code")],
    }),
    { level: "error" },
  );
  assert.deepEqual(
    resolveBetterAuthLogLevel({
      level: "error",
      message: "Something else",
      args: [new FakeStateError("x", "state_mismatch", {})],
    }),
    { level: "error" },
  );
  assert.deepEqual(
    resolveBetterAuthLogLevel({ level: "info", message: "Failed to parse state", args: [] }),
    { level: "info" },
  );
});
