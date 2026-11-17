import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import {
  builtinLinearConnectorCapabilityManifest,
  linearAgentToolDefs,
  toBackendLinearManifest,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinLinearConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinLinearConnectorCapabilityManifest);
});

test("backend manifest is tools-only with read scope and a 100-item selection", () => {
  const manifest = toBackendLinearManifest({
    clientId: "client-id",
    redirectUri: "https://sourceweft.example/callback",
  });

  assert.equal(manifest.type, "linear");
  assert.deepEqual(manifest.auth.scopes, ["read"]);
  assert.deepEqual(manifest.auth.authorizationParams, {
    prompt: "consent",
    client_id: "client-id",
  });
  assert.deepEqual(manifest.sync.resources, []);
  assert.equal(manifest.selection?.maxItems, 100);
});

test("exactly three agent actions and three internal actions, none requiring approval", () => {
  const manifest = toBackendLinearManifest({
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
  assert.deepEqual(
    agentActions.map((action) => action.agentToolName).sort(),
    ["list_linear_projects", "read_linear_issue", "search_linear_issues"],
  );
  assert.equal(internalActions.length, 3);
  for (const action of manifest.actions) {
    assert.equal(action.requiresApproval, false);
  }
});

test("linearAgentToolDefs names match the three agent tool names", () => {
  assert.deepEqual(
    linearAgentToolDefs.map((d) => d.name).sort(),
    ["list_linear_projects", "read_linear_issue", "search_linear_issues"],
  );
});
