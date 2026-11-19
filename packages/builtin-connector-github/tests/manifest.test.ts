import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import type { ConnectorManifest } from "@sourceweft/contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import {
  builtinGithubConnectorCapabilityManifest,
  githubAgentToolDefs,
  githubConnectorContribution,
  toBackendGithubManifest,
} from "../src";

const root = new URL("../", import.meta.url);

// The GitHub manifest always uses the platform's standard OAuth2 flow; this
// narrows the manifest's auth union so its OAuth2 fields can be read.
function oauth2Auth(manifest: ConnectorManifest) {
  assert.equal(manifest.auth.kind, "oauth2");
  if (manifest.auth.kind !== "oauth2") throw new Error("unreachable");
  return manifest.auth;
}

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinGithubConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinGithubConnectorCapabilityManifest);
});

test("backend manifest is tools-only", () => {
  const manifest = toBackendGithubManifest({
    clientId: "client-id",
    redirectUri: "https://sourceweft.example/callback",
  });

  assert.equal(manifest.type, "github");
  assert.deepEqual(oauth2Auth(manifest).scopes, []);
  assert.equal(oauth2Auth(manifest).sendScope, false);
  assert.deepEqual(oauth2Auth(manifest).authorizationParams, {
    client_id: "client-id",
  });
  assert.deepEqual(manifest.sync.resources, []);
  assert.equal(manifest.sync.supportsIncremental, false);
  assert.equal(manifest.selection?.maxItems, 20);
});

test("three internal and three agent actions", () => {
  const manifest = toBackendGithubManifest({
    clientId: "client-id",
    redirectUri: "https://sourceweft.example/callback",
  });

  const agentActions = manifest.actions.filter(
    (action) => action.visibility === "agent",
  );
  const internalActions = manifest.actions.filter(
    (action) => action.visibility === "internal",
  );
  assert.equal(agentActions.length, 3);
  assert.equal(internalActions.length, 3);

  const agentToolNames = agentActions
    .map((action) => action.agentToolName)
    .sort();
  assert.deepEqual(agentToolNames, [
    "list_github_repositories",
    "read_github_item",
    "search_github",
  ]);

  for (const action of manifest.actions) {
    assert.equal(action.riskLevel, "low");
    assert.equal(action.requiresApproval, false);
  }
});

test("tool definitions match the agent actions", () => {
  const manifest = toBackendGithubManifest({
    clientId: "client-id",
    redirectUri: "https://sourceweft.example/callback",
  });

  const agentToolNames = new Set(
    manifest.actions
      .filter((action) => action.visibility === "agent")
      .map((action) => action.agentToolName),
  );
  const toolDefNames = new Set(
    githubAgentToolDefs.map((toolDef) => toolDef.name),
  );
  assert.deepEqual(toolDefNames, agentToolNames);
});

test("the backend manifest's selection agrees with the contribution", () => {
  const manifest = toBackendGithubManifest({
    clientId: "client-id",
    redirectUri: "https://sourceweft.example/callback",
  });
  assert.deepEqual(manifest.selection, githubConnectorContribution.selection);
});
