import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  capabilityManifestSchema,
  parseCapabilityManifest,
} from "@sourceweft/capability-contracts";
import {
  builtinNotionConnectorCapabilityManifest,
  notionConnectorContribution,
  toBackendNotionConnectorManifest,
} from "../src";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const forbiddenRuntimeReference = ["process", "env"].join(".");
const forbiddenNetworkCall = ["fet", "ch("].join("");

test("sourceweft.capability.json matches the package manifest export", async () => {
  const rawManifest = await readFile(
    join(packageRoot, "sourceweft.capability.json"),
    "utf8",
  );

  assert.deepEqual(
    JSON.parse(rawManifest),
    builtinNotionConnectorCapabilityManifest,
  );
});

test("notion connector contribution exposes agent action schemas", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinNotionConnectorCapabilityManifest,
  );
  const connector = manifest.contributes.connectors?.[0];
  const actionNames = connector?.actions
    .filter((action) => action.visibility === "agent")
    .map((action) => action.agentToolName)
    .filter((toolName): toolName is string => typeof toolName === "string");

  assert.equal(connector?.id, "notion");
  assert.deepEqual(actionNames, [
    "create_notion_page",
    "save_artifact_to_notion",
    "save_final_answer_to_notion",
    "append_notion_page",
    "delete_notion_page",
    "search_notion_pages",
    "read_notion_page",
    "update_notion_page",
  ]);
});

test("notion connector treats prompt-like descriptions as inert metadata", () => {
  const findAction = notionConnectorContribution.actions.find(
    (action) => action.id === "notion.page.find",
  );

  assert.match(findAction?.description ?? "", /ask the user what page to find/);
  assert.equal(
    findAction?.description?.includes(forbiddenRuntimeReference),
    false,
  );
  assert.equal(findAction?.description?.includes(forbiddenNetworkCall), false);
  assert.equal(findAction?.inputSchema.additionalProperties, false);
});

test("notion connector rejects malformed connector action metadata", () => {
  const invalidConnector = {
    ...notionConnectorContribution,
    actions: [
      {
        ...notionConnectorContribution.actions[0],
        risk: "write-risk",
      },
    ],
  };

  const result = parseCapabilityManifest({
    ...builtinNotionConnectorCapabilityManifest,
    connectors: [invalidConnector],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code),
    ["manifest.invalid"],
  );
});

test("notion connector manifest embeds the exported contribution metadata", () => {
  const manifest = capabilityManifestSchema.parse(
    builtinNotionConnectorCapabilityManifest,
  );
  assert.deepEqual(
    manifest.contributes.connectors[0],
    notionConnectorContribution,
  );
});

test("backend manifest adapter injects OAuth runtime fields only at host boundary", () => {
  const manifest = toBackendNotionConnectorManifest(
    notionConnectorContribution,
    {
      clientId: "client-id",
      redirectUri: "https://app.example/callback",
    },
  );

  assert.equal(manifest.type, "notion");
  assert.equal(manifest.auth.redirectUri, "https://app.example/callback");
  assert.equal(manifest.auth.authorizationParams?.client_id, "client-id");
  assert.equal(manifest.auth.authorizationParams?.owner, "user");
  assert.equal(manifest.actions[0]?.type, "notion.page.create");
  assert.equal(manifest.actions[0]?.riskLevel, "medium");
});
