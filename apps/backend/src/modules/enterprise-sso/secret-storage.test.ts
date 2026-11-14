import assert from "node:assert/strict";
import { test, vi } from "vitest";

// secret-storage seals the OIDC `clientSecret` with the team's envelope key
// before it reaches the database. The team-secrets crypto is exercised for real
// in secret-storage.database.test.ts; here it is mocked so the seal/open JSON
// handling, the `swenc:` prefix, idempotency, and per-team isolation can be
// tested without a database. The mock emits a structurally valid
// `v2:iv:tag:ct` payload (the real `parseSecretPayload` runs against it, to
// tell real ciphertext from a sentinel-prefixed plaintext) that binds the team
// id in its ciphertext segment and fails a cross-team open.
vi.mock("../../shared/team-secrets", () => {
  const iv = Buffer.alloc(12).toString("base64");
  const tag = Buffer.alloc(16).toString("base64");
  return {
    encryptTeamSecret: async (plainText: string, teamId: string) => {
      if (!plainText) {
        return "";
      }
      if (!teamId) {
        throw new Error("A team id is required to resolve a team data key");
      }
      const ciphertext = Buffer.from(
        JSON.stringify([teamId, plainText]),
        "utf8",
      ).toString("base64");
      return `v2:${iv}:${tag}:${ciphertext}`;
    },
    decryptTeamSecret: async (cipherText: string | null, teamId: string) => {
      if (!cipherText) {
        return "";
      }
      const parts = cipherText.split(":");
      if (parts[0] !== "v2") {
        return cipherText;
      }
      const [boundTeamId, plainText] = JSON.parse(
        Buffer.from(parts[3] ?? "", "base64").toString("utf8"),
      ) as [string, string];
      if (boundTeamId !== teamId) {
        throw new Error("Unsupported state or unable to authenticate data");
      }
      return plainText;
    },
  };
});

const { SEALED_SECRET_PREFIX, sealOidcConfig, openOidcConfig } = await import(
  "./secret-storage"
);

const ORG = "org-abc";

function oidc(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    issuer: "https://idp.example.com",
    clientId: "client-123",
    clientSecret: "s3cr3t-plain",
    tokenEndpointAuthentication: "client_secret_basic",
    scopes: ["openid", "email"],
    ...overrides,
  });
}

test("seal prefixes clientSecret with swenc: and leaves every other field unchanged", async () => {
  const sealed = await sealOidcConfig(oidc(), ORG);
  const parsed = JSON.parse(sealed);

  assert.ok(
    parsed.clientSecret.startsWith(SEALED_SECRET_PREFIX),
    "clientSecret should be sealed with the swenc: prefix",
  );
  assert.notEqual(parsed.clientSecret, "s3cr3t-plain");
  assert.equal(parsed.issuer, "https://idp.example.com");
  assert.equal(parsed.clientId, "client-123");
  assert.equal(parsed.tokenEndpointAuthentication, "client_secret_basic");
  assert.deepEqual(parsed.scopes, ["openid", "email"]);
});

test("open reverses seal and restores the original clientSecret", async () => {
  const opened = await openOidcConfig(await sealOidcConfig(oidc(), ORG), ORG);
  assert.equal(JSON.parse(opened).clientSecret, "s3cr3t-plain");
});

test("seal is idempotent: resealing an already-sealed config does not double-encrypt", async () => {
  const sealed = await sealOidcConfig(oidc(), ORG);
  const resealed = await sealOidcConfig(sealed, ORG);

  // The stored ciphertext is unchanged, so it still opens to the original.
  assert.equal(JSON.parse(resealed).clientSecret, JSON.parse(sealed).clientSecret);
  assert.equal(JSON.parse(await openOidcConfig(resealed, ORG)).clientSecret, "s3cr3t-plain");
});

test("a plaintext secret that starts with swenc: is sealed, not mistaken for ciphertext", async () => {
  const sentinel = "swenc:not-a-real-payload";
  const sealed = await sealOidcConfig(oidc({ clientSecret: sentinel }), ORG);
  const sealedSecret = JSON.parse(sealed).clientSecret as string;

  assert.notEqual(
    sealedSecret,
    sentinel,
    "a sentinel-prefixed plaintext must be sealed, not stored verbatim",
  );
  assert.ok(sealedSecret.startsWith(SEALED_SECRET_PREFIX));
  assert.equal(JSON.parse(await openOidcConfig(sealed, ORG)).clientSecret, sentinel);
});

test("a config without a clientSecret (private_key_jwt) is returned unchanged", async () => {
  const config = JSON.stringify({
    issuer: "https://idp.example.com",
    clientId: "client-123",
    tokenEndpointAuthentication: "private_key_jwt",
    privateKeyId: "key-1",
  });

  assert.equal(await sealOidcConfig(config, ORG), config);
  assert.equal(await openOidcConfig(config, ORG), config);
});

test("opening a sealed config with another organization id throws", async () => {
  const sealed = await sealOidcConfig(oidc(), ORG);
  await assert.rejects(() => openOidcConfig(sealed, "org-other"));
});

test("an empty config string passes through untouched", async () => {
  assert.equal(await sealOidcConfig("", ORG), "");
  assert.equal(await openOidcConfig("", ORG), "");
});
