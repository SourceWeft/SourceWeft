import assert from "node:assert/strict";
import test from "node:test";
import { isWordPressError } from "../src/errors";
import {
  basicAuthorization,
  parseStoredCredential,
  wordPressCredentialIdentity,
} from "../src/identity";

const cfg = (siteUrl: string) => ({ siteUrl, items: [] });
const cred = (username: string) => ({ username, secret: "ignored" });

test("the credential identity changes with the site URL and username, not the password", () => {
  const a = wordPressCredentialIdentity(cfg("https://site.example"), {
    username: "editor",
    secret: "one",
  });
  const samePassword = wordPressCredentialIdentity(
    cfg("https://site.example"),
    {
      username: "editor",
      secret: "two",
    },
  );
  assert.equal(a, samePassword, "the password is not part of the identity");

  const otherHost = wordPressCredentialIdentity(
    cfg("https://other.example"),
    cred("editor"),
  );
  const otherSubfolder = wordPressCredentialIdentity(
    cfg("https://site.example/blog"),
    cred("editor"),
  );
  const otherUser = wordPressCredentialIdentity(
    cfg("https://site.example"),
    cred("writer"),
  );
  for (const other of [otherHost, otherSubfolder, otherUser]) {
    assert.notEqual(a, other);
  }
  // It is a hex sha256 digest and never embeds the username or secret.
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("the identity normalises a trailing slash and host case", () => {
  assert.equal(
    wordPressCredentialIdentity(cfg("https://Site.Example/"), cred("editor")),
    wordPressCredentialIdentity(cfg("https://site.example"), cred("editor")),
  );
});

test("parseStoredCredential accepts exactly { username, secret }", () => {
  assert.deepEqual(
    parseStoredCredential(
      JSON.stringify({ username: "editor", secret: "s3cret" }),
    ),
    { username: "editor", secret: "s3cret" },
  );
});

test("parseStoredCredential rejects anything else as a credential failure", () => {
  const bad = [
    "not json",
    JSON.stringify({ username: "editor" }),
    JSON.stringify({ username: "editor", secret: "" }),
    JSON.stringify({ username: "", secret: "s" }),
    JSON.stringify({ username: "a:b", secret: "s" }),
    JSON.stringify({ username: "editor", secret: "s", extra: 1 }),
    JSON.stringify({ username: 1, secret: "s" }),
    JSON.stringify(["editor", "s"]),
    JSON.stringify(null),
  ];
  for (const token of bad) {
    assert.throws(
      () => parseStoredCredential(token),
      (error: unknown) =>
        isWordPressError(error) && error.code === "BAD_CREDENTIALS",
      token,
    );
  }
});

test("basicAuthorization builds a Basic header and never leaks the secret in cleartext", () => {
  const header = basicAuthorization({ username: "editor", secret: "s3cret" });
  assert.equal(
    header,
    `Basic ${Buffer.from("editor:s3cret", "utf8").toString("base64")}`,
  );
  assert.ok(!header.includes("s3cret"));
});
