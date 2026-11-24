import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import {
  connectorManifestSchema,
  type ConnectorManifest,
} from "@sourceweft/contracts";
import {
  JIRA_SCOPES,
  builtinJiraConnectorCapabilityManifest,
  jiraConnectorContribution,
  toBackendJiraManifest,
} from "../src";

// The Jira manifest always uses the platform's standard OAuth2 flow; this
// narrows the manifest's auth union so its OAuth2 fields can be read.
function oauth2Auth(manifest: ConnectorManifest) {
  assert.equal(manifest.auth.kind, "oauth2");
  if (manifest.auth.kind !== "oauth2") throw new Error("unreachable");
  return manifest.auth;
}

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinJiraConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinJiraConnectorCapabilityManifest);
});

test("backend manifest exposes the Jira scopes, auth params, empty sync resources and selection", () => {
  const manifest = toBackendJiraManifest({
    clientId: "app",
    redirectUri: "https://sourceweft.example/callback",
  });

  assert.equal(manifest.type, "jira");
  assert.deepEqual(oauth2Auth(manifest).scopes, [...JIRA_SCOPES]);
  assert.equal(oauth2Auth(manifest).scopes.length, 4);
  assert.deepEqual(oauth2Auth(manifest).authorizationParams, {
    audience: "api.atlassian.com",
    prompt: "consent",
    client_id: "app",
  });
  assert.equal(
    oauth2Auth(manifest).redirectUri,
    "https://sourceweft.example/callback",
  );
  assert.equal(manifest.sync.supportsIncremental, false);
  assert.deepEqual(manifest.sync.resources, []);
  assert.deepEqual(manifest.selection, {
    actions: {
      browse: "jira.browse",
      search: "jira.search",
      describe: "jira.describe",
    },
    kinds: ["site", "project"],
    maxItems: 100,
  });
});

test("the manifest declares three internal selection actions and three agent actions", () => {
  const manifest = toBackendJiraManifest({
    clientId: "app",
    redirectUri: "https://sourceweft.example/callback",
  });

  const internal = manifest.actions.filter(
    (action) => action.visibility === "internal",
  );
  const agent = manifest.actions.filter(
    (action) => action.visibility === "agent",
  );
  assert.deepEqual(
    internal.map((action) => action.type).sort(),
    ["jira.browse", "jira.describe", "jira.search"],
  );
  assert.deepEqual(
    agent.map((action) => action.agentToolName).sort(),
    ["list_jira_projects", "read_jira_issue", "search_jira_issues"],
  );
});

test("the backend manifest parses and its selection agrees with the contribution", () => {
  // The backend `connectorSelectionSpecSchema` and the contribution's
  // `connectorSelectionSpecSchema` are defined separately in two packages
  // that do not depend on each other; this guards that they agree on a real
  // manifest.
  const backendManifest = connectorManifestSchema.parse(
    toBackendJiraManifest({
      clientId: "app",
      redirectUri: "https://sourceweft.example/callback",
    }),
  );
  assert.deepEqual(backendManifest.selection, jiraConnectorContribution.selection);
});
