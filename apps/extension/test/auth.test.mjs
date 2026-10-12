import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the shipped background, including its real message dispatcher.
const source = readFileSync(
  new URL("../entrypoints/background.ts", import.meta.url),
  "utf8",
)
  .replace(
    'import { defineBackground } from "wxt/utils/define-background";',
    "",
  )
  .replaceAll("import.meta", "({ env: {} })");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const key = "sourceweft.auth.tokens";
const initial = () => ({
  accessToken: "old",
  refreshToken: "refresh-old",
  clientId: "client",
  expiresAt: Date.now() + 3600_000,
});
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
const tokens = (name) =>
  response({
    access_token: name,
    refresh_token: `refresh-${name}`,
    expires_in: 3600,
  });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function background({ fetch, beforeSet = async () => {} }) {
  let stored = initial();
  let listener;
  const context = vm.createContext({
    exports: {},
    defineBackground: (value) => value,
    URL,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    Date,
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    console: { log() {}, warn() {} },
    fetch: async (url, options) =>
      url.endsWith("/register")
        ? response({ client_id: "new-client" })
        : fetch(url, options),
    chrome: {
      storage: {
        local: {
          get: async () => ({ [key]: stored }),
          set: async (value) => {
            await beforeSet(value[key]);
            stored = value[key];
          },
          remove: async () => {
            stored = undefined;
          },
        },
      },
      identity: {
        getRedirectURL: () => "https://extension.test/provider_cb",
        launchWebAuthFlow: async ({ url }) =>
          `https://extension.test/provider_cb?code=code&state=${new URL(url).searchParams.get("state")}`,
      },
      runtime: {
        onMessage: {
          addListener: (value) => {
            listener = value;
          },
        },
      },
    },
  });
  vm.runInContext(compiled, context);
  context.exports.default.main();
  // Let startup's non-expired session check finish before each controlled race.
  await new Promise(setImmediate);
  return {
    command: (command) =>
      new Promise((resolve) => listener({ command }, {}, resolve)),
    stored: () => stored,
    expire: () => {
      stored.expiresAt = 0;
    },
  };
}

test("a late refresh response cannot undo sign-out", async () => {
  const started = deferred(),
    reply = deferred();
  const app = await background({
    fetch: () => {
      started.resolve();
      return reply.promise;
    },
  });
  const refreshing = app.command("auth.refresh");
  await started.promise;
  assert.equal((await app.command("auth.sign-out")).ok, true);
  reply.resolve(tokens("stale"));
  await refreshing;
  assert.equal(app.stored(), undefined);
});

test("sign-out waits behind an already-started storage write and removes it", async () => {
  const writing = deferred(),
    release = deferred();
  const app = await background({
    fetch: async () => tokens("stale"),
    beforeSet: async () => {
      writing.resolve();
      await release.promise;
    },
  });
  const refreshing = app.command("auth.refresh");
  await writing.promise;
  const signingOut = app.command("auth.sign-out");
  release.resolve();
  await Promise.all([refreshing, signingOut]);
  assert.equal(app.stored(), undefined);
});

test("a cancelled later sign-in cannot skip an already-queued sign-out", async () => {
  const writing = deferred(),
    release = deferred();
  const app = await background({
    fetch: async (_url, options) => {
      if (
        new URLSearchParams(options.body).get("grant_type") ===
        "authorization_code"
      )
        throw new TypeError("Sign-in could not complete");
      return tokens("stale");
    },
    beforeSet: async () => {
      writing.resolve();
      await release.promise;
    },
  });
  const refreshing = app.command("auth.refresh");
  await writing.promise;
  const signingOut = app.command("auth.sign-out");
  assert.equal((await app.command("auth.sign-in")).ok, false);
  release.resolve();
  const [, result] = await Promise.all([refreshing, signingOut]);
  assert.equal(result.ok, true);
  assert.equal(app.stored(), undefined);
});

test("an earlier refresh cannot replace a newly signed-in account", async () => {
  const started = deferred(),
    reply = deferred();
  const app = await background({
    fetch: async (_url, options) => {
      if (
        new URLSearchParams(options.body).get("grant_type") ===
        "authorization_code"
      )
        return tokens("new-user");
      started.resolve();
      return reply.promise;
    },
  });
  const refreshing = app.command("auth.refresh");
  await started.promise;
  assert.equal((await app.command("auth.sign-in")).ok, true);
  reply.resolve(tokens("old-user-refreshed"));
  await refreshing;
  assert.equal(app.stored().accessToken, "new-user");
});

test("a failed sign-in attempt does not discard a refresh of the current account", async () => {
  const started = deferred(),
    reply = deferred();
  const app = await background({
    fetch: (_url, options) => {
      if (
        new URLSearchParams(options.body).get("grant_type") ===
        "authorization_code"
      )
        return Promise.reject(new TypeError("Sign-in unavailable"));
      started.resolve();
      return reply.promise;
    },
  });
  const refreshing = app.command("auth.refresh");
  await started.promise;
  assert.equal((await app.command("auth.sign-in")).ok, false);
  reply.resolve(tokens("current-user-refreshed"));
  assert.equal((await refreshing).ok, true);
  assert.equal(app.stored().accessToken, "current-user-refreshed");
});

test("a new sign-in is ordered after a pending old storage write", async () => {
  const writing = deferred(),
    release = deferred(),
    loginExchanged = deferred();
  const app = await background({
    fetch: async (_url, options) => {
      const signingIn =
        new URLSearchParams(options.body).get("grant_type") ===
        "authorization_code";
      if (signingIn) loginExchanged.resolve();
      return tokens(signingIn ? "new-user" : "old-user-refreshed");
    },
    beforeSet: async (value) => {
      if (value.accessToken === "old-user-refreshed") {
        writing.resolve();
        await release.promise;
      }
    },
  });
  const refreshing = app.command("auth.refresh");
  await writing.promise;
  const signingIn = app.command("auth.sign-in");
  await loginExchanged.promise;
  await new Promise(setImmediate);
  release.resolve();
  await Promise.all([refreshing, signingIn]);
  assert.equal(app.stored().accessToken, "new-user");
});

test("a refresh started during interactive sign-in cannot overwrite its result", async () => {
  const loginStarted = deferred(),
    loginReply = deferred();
  const refreshStarted = deferred(),
    refreshReply = deferred();
  const app = await background({
    fetch: (_url, options) => {
      if (
        new URLSearchParams(options.body).get("grant_type") ===
        "authorization_code"
      ) {
        loginStarted.resolve();
        return loginReply.promise;
      }
      refreshStarted.resolve();
      return refreshReply.promise;
    },
  });
  const signingIn = app.command("auth.sign-in");
  await loginStarted.promise;
  const refreshing = app.command("auth.refresh");
  await refreshStarted.promise;
  loginReply.resolve(tokens("new-user"));
  await signingIn;
  refreshReply.resolve(tokens("old-user-refreshed"));
  await refreshing;
  assert.equal(app.stored().accessToken, "new-user");
});

test("a late invalid_grant for the old account cannot clear the new account", async () => {
  const started = deferred(),
    reply = deferred();
  const app = await background({
    fetch: (_url, options) => {
      if (
        new URLSearchParams(options.body).get("grant_type") ===
        "authorization_code"
      )
        return Promise.resolve(tokens("new-user"));
      started.resolve();
      return reply.promise;
    },
  });
  const refreshing = app.command("auth.refresh");
  await started.promise;
  await app.command("auth.sign-in");
  reply.resolve(response({ error: "invalid_grant" }, 400));
  await refreshing;
  assert.equal(app.stored().accessToken, "new-user");
});

test("concurrent expiry checks share a single refresh request", async () => {
  const started = deferred(),
    reply = deferred();
  let calls = 0;
  const app = await background({
    fetch: () => {
      calls++;
      started.resolve();
      return reply.promise;
    },
  });
  app.expire();
  const first = app.command("auth.session"),
    second = app.command("auth.session");
  await started.promise;
  reply.resolve(tokens("fresh"));
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.ok && result.data.authenticated));
});

for (const failure of ["offline", "server-error"]) {
  test(`${failure} preserves the refresh token and allows a later retry`, async () => {
    let retry = false;
    const app = await background({
      fetch: async () => {
        if (retry) return tokens("recovered");
        if (failure === "offline") throw new TypeError("Failed to fetch");
        return response({ error: "server_error" }, 503);
      },
    });
    app.expire();
    const failed = await app.command("auth.session");
    assert.equal(failed.ok, false);
    assert.equal(app.stored()?.refreshToken, "refresh-old");
    retry = true;
    assert.equal((await app.command("auth.session")).data.authenticated, true);
    assert.equal(app.stored().accessToken, "recovered");
  });
}

test("invalid_grant clears an irrecoverably revoked refresh token", async () => {
  const app = await background({
    fetch: async () => response({ error: "invalid_grant" }, 400),
  });
  app.expire();
  const result = await app.command("auth.session");
  assert.equal(result.ok, true);
  assert.equal(result.data.authenticated, false);
  assert.equal(app.stored(), undefined);
});
