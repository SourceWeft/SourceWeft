import assert from "node:assert/strict";
import test from "node:test";
import {
  checkConnectorConfigRequestSchema,
  connectorCredentialInputSchema,
  connectorCredentialStatusSchema,
  connectorManifestSchema,
  createConnectorRequestSchema,
  rotateConnectorCredentialRequestSchema,
} from "../src/connectors";

function baseManifest(auth: unknown) {
  return {
    type: "webdav",
    displayName: "WebDAV",
    auth,
    sync: {
      supportsIncremental: true,
      defaultFrequencyMinutes: 360,
      resources: [],
    },
    actions: [],
    configSchema: {},
  };
}

test("accepts a credential/basic auth manifest", () => {
  const result = connectorManifestSchema.safeParse(
    baseManifest({ kind: "credential", scheme: "basic" }),
  );
  assert.equal(result.success, true);
});

test("rejects a credential manifest with an unknown scheme or none", () => {
  assert.equal(
    connectorManifestSchema.safeParse(
      baseManifest({ kind: "credential", scheme: "digest" }),
    ).success,
    false,
  );
  assert.equal(
    connectorManifestSchema.safeParse(baseManifest({ kind: "credential" }))
      .success,
    false,
  );
});

test("credential input trims the username and requires both fields", () => {
  const parsed = connectorCredentialInputSchema.parse({
    username: "  alice  ",
    secret: " keep spaces ",
  });
  assert.deepEqual(parsed, { username: "alice", secret: " keep spaces " });
  assert.equal(
    connectorCredentialInputSchema.safeParse({ username: " ", secret: "x" })
      .success,
    false,
  );
  assert.equal(
    connectorCredentialInputSchema.safeParse({ username: "a", secret: "" })
      .success,
    false,
  );
  assert.equal(
    connectorCredentialInputSchema.safeParse({
      username: "a".repeat(201),
      secret: "x",
    }).success,
    false,
  );
  assert.equal(
    connectorCredentialInputSchema.safeParse({
      username: "a",
      secret: "x".repeat(2001),
    }).success,
    false,
  );
});

test("create and check requests carry the credential through unchanged", () => {
  const credential = { username: "alice", secret: "s3cret" };
  const create = createConnectorRequestSchema.parse({
    connectorType: "webdav",
    name: "Drive",
    configJson: { baseUrl: "https://dav.example.com/" },
    credential,
  });
  assert.deepEqual(create.credential, credential);
  const check = checkConnectorConfigRequestSchema.parse({
    connectorType: "webdav",
    configJson: { baseUrl: "https://dav.example.com/" },
    credential,
  });
  assert.deepEqual(check.credential, credential);
  assert.equal(
    createConnectorRequestSchema.parse({ connectorType: "rss", name: "Feed" })
      .credential,
    undefined,
  );
});

test("rotate request is the credential input and status exposes no secret", () => {
  assert.deepEqual(
    rotateConnectorCredentialRequestSchema.parse({
      username: "bob",
      secret: "new",
    }),
    { username: "bob", secret: "new" },
  );
  assert.deepEqual(
    connectorCredentialStatusSchema.parse({
      credentialConfigured: true,
      displayName: null,
    }),
    { credentialConfigured: true, displayName: null },
  );
  assert.equal(
    connectorCredentialStatusSchema.safeParse({ credentialConfigured: true })
      .success,
    false,
  );
});

test("accepts a credential/api_key auth manifest and round-trips it", () => {
  const auth = { kind: "credential", scheme: "api_key" };
  const result = connectorManifestSchema.safeParse(baseManifest(auth));
  assert.equal(result.success, true);
  if (result.success) assert.deepEqual(result.data.auth, auth);
});

test("rejects a credential manifest with the token scheme", () => {
  assert.equal(
    connectorManifestSchema.safeParse(
      baseManifest({ kind: "credential", scheme: "token" }),
    ).success,
    false,
  );
});

test("api_key scheme still parses alongside the login_flow marker", () => {
  const auth = { kind: "credential", scheme: "api_key", flow: "login_flow" };
  const result = connectorManifestSchema.safeParse(baseManifest(auth));
  assert.equal(result.success, true);
  if (result.success) assert.deepEqual(result.data.auth, auth);
});
