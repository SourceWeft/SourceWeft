import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

// Verifying an address needs a delivered email. A deployment that cannot send
// one (the self-hosted default) must not demand it: its operator would be
// locked out of their own installation on the first sign-in.

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function requireEmailVerificationWith(provider: string | undefined) {
  vi.resetModules();
  if (provider === undefined) vi.stubEnv("MAIL_PROVIDER", "");
  else vi.stubEnv("MAIL_PROVIDER", provider);
  const { createSourceweftAuth } = await import("./auth-config");
  // "migration" builds the same options without the runtime-only mail hooks.
  const auth = createSourceweftAuth({ mode: "migration" });
  return auth.options.emailAndPassword.requireEmailVerification as boolean;
}

test("no mail provider configured: sign-in does not wait for a verification email", async () => {
  assert.equal(await requireEmailVerificationWith(undefined), false);
  assert.equal(await requireEmailVerificationWith("console"), false);
  assert.equal(await requireEmailVerificationWith("noop"), false);
});

test("a delivering mail provider: a verified address is required, as before", async () => {
  assert.equal(await requireEmailVerificationWith("plunk"), true);
});
