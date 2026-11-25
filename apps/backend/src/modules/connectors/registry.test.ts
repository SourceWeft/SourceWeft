import assert from "node:assert/strict";
import { test } from "vitest";
import { ConnectorError } from "./errors";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

const manifest: ConnectorManifest = {
  type: "fake",
  displayName: "Fake",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://provider.example/oauth/authorize",
    tokenUrl: "https://provider.example/oauth/token",
    scopes: ["read"],
  },
  sync: {
    supportsIncremental: true,
    defaultFrequencyMinutes: 60,
    resources: [],
  },
  actions: [
    {
      type: "fake.item.create",
      displayName: "Create fake item",
      agentToolName: "fake_item_create",
      description: "Create a fake item.",
      visibility: "agent",
      capabilities: ["connector_write", "connector_create"],
      riskLevel: "medium",
      requiresApproval: true,
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
        },
      },
    },
  ],
  configSchema: { type: "object" },
};

const adapter: ConnectorAdapter = {
  getManifest: () => manifest,
  exchangeOAuthCode: async () => ({ accessToken: "token" }),
  refreshOAuthToken: async () => ({ accessToken: "token" }),
  async *discover() {},
  extract: async ({ item }) => ({ item, contentText: "" }),
  executeAction: async () => ({ result: {} }),
};

test("ConnectorRegistry registers adapters and lists manifests", () => {
  const registry = new ConnectorRegistry([adapter]);

  assert.equal(registry.getAdapter("fake"), adapter);
  assert.deepEqual(registry.listManifests(), [manifest]);
});

test("ConnectorRegistry preserves agent-facing action metadata", () => {
  const registry = new ConnectorRegistry([adapter]);
  const [action] = registry.getManifest("fake").actions;

  assert.equal(action?.agentToolName, "fake_item_create");
  assert.equal(action?.visibility, "agent");
  assert.deepEqual(action?.capabilities, [
    "connector_write",
    "connector_create",
  ]);
});

test("ConnectorRegistry rejects missing adapters with connector error", () => {
  const registry = new ConnectorRegistry();

  assert.throws(
    () => registry.getAdapter("missing"),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_ADAPTER_NOT_FOUND",
  );
});

const noneManifest: ConnectorManifest = {
  ...manifest,
  type: "feedlike",
  auth: { kind: "none" },
  actions: [],
};

const brokeredManifest: ConnectorManifest = {
  ...manifest,
  type: "brokered-fake",
  auth: { kind: "brokered", broker: "composio", scopes: ["read"] },
  actions: [],
};

function assertManifestInvalid(register: () => unknown, pattern: RegExp) {
  assert.throws(
    register,
    (error) =>
      error instanceof ConnectorError &&
      error.statusCode === 500 &&
      error.code === "CONNECTOR_MANIFEST_INVALID" &&
      pattern.test(error.message),
  );
}

test("ConnectorRegistry rejects an oauth2 adapter without refreshOAuthToken", () => {
  const { refreshOAuthToken: _omitted, ...partial } = adapter;
  assertManifestInvalid(
    () => new ConnectorRegistry([partial]),
    /fake.*refreshOAuthToken/,
  );
});

test("ConnectorRegistry rejects an oauth2 adapter without exchangeOAuthCode", () => {
  const { exchangeOAuthCode: _omitted, ...partial } = adapter;
  assertManifestInvalid(
    () => new ConnectorRegistry([partial]),
    /fake.*exchangeOAuthCode/,
  );
});

test("ConnectorRegistry rejects a none adapter that implements OAuth methods", () => {
  const { refreshOAuthToken: _omitted, ...onlyExchange } = adapter;
  assertManifestInvalid(
    () =>
      new ConnectorRegistry([
        { ...onlyExchange, getManifest: () => noneManifest },
      ]),
    /feedlike.*exchangeOAuthCode/,
  );
  const { exchangeOAuthCode: _omitted2, ...onlyRefresh } = adapter;
  assertManifestInvalid(
    () =>
      new ConnectorRegistry([
        { ...onlyRefresh, getManifest: () => noneManifest },
      ]),
    /feedlike.*refreshOAuthToken/,
  );
});

test("ConnectorRegistry registers a none adapter without OAuth methods", () => {
  const {
    exchangeOAuthCode: _exchange,
    refreshOAuthToken: _refresh,
    ...noOAuth
  } = adapter;
  const registry = new ConnectorRegistry([
    { ...noOAuth, getManifest: () => noneManifest },
  ]);

  assert.equal(registry.getManifest("feedlike").auth.kind, "none");
});

test("ConnectorRegistry leaves a brokered adapter unconstrained", () => {
  const {
    exchangeOAuthCode: _exchange,
    refreshOAuthToken: _refresh,
    ...noOAuth
  } = adapter;
  const registry = new ConnectorRegistry([
    { ...noOAuth, getManifest: () => brokeredManifest },
  ]);

  assert.equal(registry.getManifest("brokered-fake").auth.kind, "brokered");
});

const credentialManifest: ConnectorManifest = {
  ...manifest,
  type: "webdavlike",
  auth: { kind: "credential", scheme: "basic" },
  actions: [],
};

test("ConnectorRegistry rejects a credential adapter that implements OAuth methods", () => {
  const { refreshOAuthToken: _omitted, ...onlyExchange } = adapter;
  assertManifestInvalid(
    () =>
      new ConnectorRegistry([
        { ...onlyExchange, getManifest: () => credentialManifest },
      ]),
    /webdavlike.*'credential'.*exchangeOAuthCode/,
  );
  const { exchangeOAuthCode: _omitted2, ...onlyRefresh } = adapter;
  assertManifestInvalid(
    () =>
      new ConnectorRegistry([
        { ...onlyRefresh, getManifest: () => credentialManifest },
      ]),
    /webdavlike.*'credential'.*refreshOAuthToken/,
  );
});

test("ConnectorRegistry registers a credential adapter without OAuth methods", () => {
  const {
    exchangeOAuthCode: _exchange,
    refreshOAuthToken: _refresh,
    ...noOAuth
  } = adapter;
  const registry = new ConnectorRegistry([
    { ...noOAuth, getManifest: () => credentialManifest },
  ]);

  assert.equal(registry.getManifest("webdavlike").auth.kind, "credential");
});

const loginFlowManifest: ConnectorManifest = {
  ...manifest,
  type: "flowlike",
  auth: { kind: "credential", scheme: "basic", flow: "login_flow" },
  actions: [],
};

const credentialFlow: NonNullable<ConnectorAdapter["credentialFlow"]> = {
  start: async () => ({
    loginUrl: "https://cloud.example.com/login",
    pending: {},
  }),
  poll: async () => ({ status: "pending" }),
};

test("ConnectorRegistry registers a login_flow adapter that implements credentialFlow", () => {
  const {
    exchangeOAuthCode: _exchange,
    refreshOAuthToken: _refresh,
    ...noOAuth
  } = adapter;
  const registry = new ConnectorRegistry([
    { ...noOAuth, getManifest: () => loginFlowManifest, credentialFlow },
  ]);

  assert.equal(registry.getManifest("flowlike").auth.kind, "credential");
});

test("ConnectorRegistry rejects a login_flow manifest without credentialFlow", () => {
  const {
    exchangeOAuthCode: _exchange,
    refreshOAuthToken: _refresh,
    ...noOAuth
  } = adapter;
  assertManifestInvalid(
    () =>
      new ConnectorRegistry([
        { ...noOAuth, getManifest: () => loginFlowManifest },
      ]),
    /flowlike.*login_flow.*does not implement credentialFlow/,
  );
});

test("ConnectorRegistry rejects credentialFlow without a login_flow credential manifest", () => {
  const {
    exchangeOAuthCode: _exchange,
    refreshOAuthToken: _refresh,
    ...noOAuth
  } = adapter;
  assertManifestInvalid(
    () =>
      new ConnectorRegistry([
        { ...noOAuth, getManifest: () => credentialManifest, credentialFlow },
      ]),
    /webdavlike.*credentialFlow.*login_flow/,
  );
  assertManifestInvalid(
    () => new ConnectorRegistry([{ ...adapter, credentialFlow }]),
    /fake.*credentialFlow.*login_flow/,
  );
});
