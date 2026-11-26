import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ZoteroError } from "../src/errors";
import {
  parseStoredCredential,
  zoteroCredentialIdentity,
} from "../src/identity";

const SECRET = "abcdEFGH12345678abcdEFGH";
const credential = (secret: string) => ({ username: "ignored", secret });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("identity is sha256 of the library prefix, stable across key rotation", () => {
  const config = { libraryType: "user", libraryId: "12345" };
  const identity = zoteroCredentialIdentity(config, credential(SECRET));
  assert.equal(identity, sha("zotero\nusers/12345"));
  assert.equal(
    zoteroCredentialIdentity(config, credential("zzzzYYYY99999999zzzzYYYY")),
    identity,
  );
  assert.doesNotMatch(identity, new RegExp(SECRET));
});

test("identity differs by library type and id", () => {
  const user = zoteroCredentialIdentity(
    { libraryType: "user", libraryId: "7" },
    credential(SECRET),
  );
  const group = zoteroCredentialIdentity(
    { libraryType: "group", libraryId: "7" },
    credential(SECRET),
  );
  const other = zoteroCredentialIdentity(
    { libraryType: "user", libraryId: "8" },
    credential(SECRET),
  );
  assert.equal(group, sha("zotero\ngroups/7"));
  assert.equal(new Set([user, group, other]).size, 3);
});

test("an invalid config is ZOTERO_CONFIG_INVALID", () => {
  const bad: Record<string, unknown>[] = [
    {},
    { libraryType: "user" },
    { libraryId: "1" },
    { libraryType: "team", libraryId: "1" },
    { libraryType: "user", libraryId: "0" },
    { libraryType: "user", libraryId: "012" },
    { libraryType: "user", libraryId: "1234567890123" },
    { libraryType: "user", libraryId: "1/../2" },
    { libraryType: "user", libraryId: 5 },
  ];
  for (const config of bad) {
    assert.throws(
      () => zoteroCredentialIdentity(config, credential(SECRET)),
      (error) =>
        error instanceof ZoteroError && error.code === "ZOTERO_CONFIG_INVALID",
    );
  }
});

test("a well-formed stored credential parses", () => {
  assert.deepEqual(
    parseStoredCredential(
      JSON.stringify({ username: "users/1", secret: SECRET }),
    ),
    { username: "users/1", secret: SECRET },
  );
});

test("every malformed stored credential is a fixed reauth error", () => {
  const bad: string[] = [
    "not json",
    "",
    "null",
    JSON.stringify([SECRET, "users/1"]),
    JSON.stringify({ username: "users/1", secret: SECRET, extra: "x" }),
    JSON.stringify({ username: "users/1" }),
    JSON.stringify({ secret: SECRET }),
    JSON.stringify({ username: "users/1", secret: "" }),
    JSON.stringify({ username: "", secret: SECRET }),
    JSON.stringify({ username: "users/1", secret: "abc def1234" }),
    JSON.stringify({ username: "users/1", secret: "abcdef\n1234" }),
    JSON.stringify({ username: "users/1", secret: "abcdef\t1234" }),
    JSON.stringify({ username: "users/1", secret: "abcdéf1234" }),
    JSON.stringify({ username: "users/1", secret: "abcd\u0000ef" }),
    JSON.stringify({ username: 5, secret: SECRET }),
    JSON.stringify({ username: "users/1", secret: 12345 }),
  ];
  for (const stored of bad) {
    assert.throws(
      () => parseStoredCredential(stored),
      (error) => {
        assert.ok(error instanceof ZoteroError);
        assert.equal(error.code, "ZOTERO_REAUTH_REQUIRED");
        assert.ok(!error.message.includes(SECRET));
        assert.ok(!error.message.includes("abcd"));
        return true;
      },
      stored,
    );
  }
});

test("a username that is not users/<id> or groups/<id> is rejected", () => {
  for (const username of [
    "alice",
    "users/",
    "users/abc",
    "teams/1",
    "users/1/x",
  ]) {
    assert.throws(
      () => parseStoredCredential(JSON.stringify({ username, secret: SECRET })),
      (error) =>
        error instanceof ZoteroError && error.code === "ZOTERO_REAUTH_REQUIRED",
      username,
    );
  }
  assert.equal(
    parseStoredCredential(
      JSON.stringify({ username: "groups/99", secret: SECRET }),
    ).username,
    "groups/99",
  );
});
