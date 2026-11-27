import assert from "node:assert/strict";
import test from "node:test";
import { GhostError } from "../src/errors";
import {
  ghostCredentialIdentity,
  parseStoredCredential,
} from "../src/identity";
import { DEFAULT_KEY } from "./helpers/fake-ghost";

const KEY = DEFAULT_KEY;
const stored = (value: unknown) => JSON.stringify(value);

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof GhostError, String(error));
    return error.code;
  }
  assert.fail("expected a GhostError");
}

test("the stored credential yields the key and nothing else", () => {
  assert.deepEqual(
    parseStoredCredential(stored({ username: "ghost", secret: KEY })),
    { secret: KEY },
  );
  // The username is not used; the secret alone is enough.
  assert.deepEqual(parseStoredCredential(stored({ secret: KEY })), {
    secret: KEY,
  });
});

test("a malformed stored credential is BAD_CREDENTIALS, never echoed", () => {
  const bad: string[] = [
    "not json",
    "null",
    "[]",
    stored("string"),
    stored({}),
    stored({ username: "ghost" }),
    stored({ username: "ghost", secret: "" }),
    stored({ username: "ghost", secret: 1 }),
    stored({ username: 1, secret: KEY }),
    stored({ username: "ghost", secret: KEY, extra: "x" }),
    stored({ username: "ghost", secret: "has space" }),
    stored({ username: "ghost", secret: "new\nline" }),
    stored({ username: "ghost", secret: "ünïcode" }),
    stored({ username: "ghost", secret: "k".repeat(257) }),
  ];
  for (const token of bad) {
    try {
      parseStoredCredential(token);
      assert.fail(`accepted ${token}`);
    } catch (error) {
      assert.ok(error instanceof GhostError);
      assert.equal(error.code, "BAD_CREDENTIALS");
      assert.ok(!error.message.includes("space"));
      assert.equal(error.cause, undefined);
    }
  }
});

test("the credential identity follows the site, not the key", () => {
  const config = (siteUrl: string) => ({ siteUrl, items: [] });
  const a = ghostCredentialIdentity(config("https://site.example"), {
    username: "ghost",
    secret: KEY,
  });
  assert.match(a, /^[0-9a-f]{64}$/);
  // A rotated key (or another username) keeps the account.
  assert.equal(
    ghostCredentialIdentity(config("https://site.example"), {
      username: "other",
      secret: "ffffffffffffffffffffffffff",
    }),
    a,
  );
  // The normalised site base is what counts: case and a trailing slash do not.
  assert.equal(
    ghostCredentialIdentity(config("https://SITE.example/"), {
      username: "ghost",
      secret: KEY,
    }),
    a,
  );
  // Another host or another subfolder is another account.
  const other = ghostCredentialIdentity(config("https://other.example"), {
    username: "ghost",
    secret: KEY,
  });
  const folder = ghostCredentialIdentity(config("https://site.example/blog"), {
    username: "ghost",
    secret: KEY,
  });
  assert.notEqual(other, a);
  assert.notEqual(folder, a);
  assert.notEqual(folder, other);
  // The selection is not part of it.
  assert.equal(
    ghostCredentialIdentity(
      { siteUrl: "https://site.example", items: [{ id: "type:post" }] },
      { username: "ghost", secret: KEY },
    ),
    a,
  );
  // Never contains the key.
  assert.ok(!a.includes(KEY));
});

test("the credential identity needs a valid site address", () => {
  const credential = { username: "ghost", secret: KEY };
  for (const siteUrl of [
    undefined,
    "",
    "http://site.example",
    "https://localhost",
    "https://127.0.0.1",
    42,
  ]) {
    assert.equal(
      codeOf(() => ghostCredentialIdentity({ siteUrl }, credential)),
      "SITE_URL_INVALID",
    );
  }
});
