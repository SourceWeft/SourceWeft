import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorManifestSchema,
  pollCredentialFlowRequestSchema,
  pollCredentialFlowResponseSchema,
  startCredentialFlowRequestSchema,
  startCredentialFlowResponseSchema,
} from "../src/connectors";

function baseManifest(auth: unknown) {
  return {
    type: "nextcloud",
    displayName: "Nextcloud",
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

test("credential auth accepts the optional login_flow marker", () => {
  const withFlow = connectorManifestSchema.safeParse(
    baseManifest({ kind: "credential", scheme: "basic", flow: "login_flow" }),
  );
  assert.equal(withFlow.success, true);
  const without = connectorManifestSchema.safeParse(
    baseManifest({ kind: "credential", scheme: "basic" }),
  );
  assert.equal(without.success, true);
  assert.equal(
    connectorManifestSchema.safeParse(
      baseManifest({ kind: "credential", scheme: "basic", flow: "device" }),
    ).success,
    false,
  );
});

test("start request validates and rejects extra fields", () => {
  const parsed = startCredentialFlowRequestSchema.parse({
    serverUrl: "https://cloud.example.com/nextcloud",
    name: "  Team cloud  ",
    roots: ["/", "/Docs"],
    periodicIndexingEnabled: true,
    connectorId: "c1",
  });
  assert.equal(parsed.name, "Team cloud");
  assert.equal(
    startCredentialFlowRequestSchema.safeParse({
      serverUrl: "https://cloud.example.com",
      name: "x",
    }).success,
    true,
  );
  for (const bad of [
    { serverUrl: "", name: "x" },
    { serverUrl: "https://a.example/" + "a".repeat(2048), name: "x" },
    { serverUrl: "https://a.example", name: "  " },
    { serverUrl: "https://a.example", name: "a".repeat(201) },
    {
      serverUrl: "https://a.example",
      name: "x",
      roots: ["/"].concat(Array(20).fill("/a")),
    },
    { serverUrl: "https://a.example", name: "x", roots: ["a".repeat(513)] },
    // An empty roots array must be rejected at start (it previously passed start
    // and failed only after approval, orphaning the issued app password).
    { serverUrl: "https://a.example", name: "x", roots: [] },
    { serverUrl: "https://a.example", name: "x", extra: 1 },
  ]) {
    assert.equal(
      startCredentialFlowRequestSchema.safeParse(bad).success,
      false,
    );
  }
});

test("start response requires an http(s) loginUrl and is strict", () => {
  const flowId = "f".repeat(32);
  assert.equal(
    startCredentialFlowResponseSchema.safeParse({
      flowId,
      loginUrl: "https://cloud.example.com/login/v2/flow/abc",
    }).success,
    true,
  );
  for (const bad of [
    { flowId, loginUrl: "not a url" },
    { flowId, loginUrl: "javascript:alert(1)" },
    { flowId, loginUrl: "ftp://cloud.example.com/x" },
    { flowId, loginUrl: "https://cloud.example.com/x", extra: true },
  ]) {
    assert.equal(
      startCredentialFlowResponseSchema.safeParse(bad).success,
      false,
    );
  }
});

test("poll request bounds the flow id and is strict", () => {
  assert.equal(
    pollCredentialFlowRequestSchema.safeParse({ flowId: "a".repeat(16) })
      .success,
    true,
  );
  for (const bad of [
    { flowId: "a".repeat(15) },
    { flowId: "a".repeat(129) },
    { flowId: "a".repeat(16), extra: 1 },
    {},
  ]) {
    assert.equal(pollCredentialFlowRequestSchema.safeParse(bad).success, false);
  }
});

test("poll response is a union on status", () => {
  assert.equal(
    pollCredentialFlowResponseSchema.safeParse({ status: "pending" }).success,
    true,
  );
  assert.equal(
    pollCredentialFlowResponseSchema.safeParse({ status: "expired" }).success,
    true,
  );
  assert.equal(
    pollCredentialFlowResponseSchema.safeParse({ status: "authorized" })
      .success,
    false,
  );
  assert.equal(
    pollCredentialFlowResponseSchema.safeParse({ status: "pending", x: 1 })
      .success,
    false,
  );
  assert.equal(
    pollCredentialFlowResponseSchema.safeParse({ status: "connected" }).success,
    false,
  );
  assert.equal(
    pollCredentialFlowResponseSchema.safeParse({
      status: "connected",
      connector: { id: "not a connector" },
    }).success,
    false,
  );
});
