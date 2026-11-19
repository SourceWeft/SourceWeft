import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import {
  connectorManifestSchema,
  type ConnectorManifest,
} from "@sourceweft/contracts";
import {
  CONFLUENCE_MAX_SELECTED_ITEMS,
  CONFLUENCE_PAGE_ID_PATTERN,
  CONFLUENCE_SCOPES,
  CONFLUENCE_SITE_ID_PATTERN,
  CONFLUENCE_SPACE_ID_PATTERN,
  builtinConfluenceConnectorCapabilityManifest,
  confluenceConnectorContribution,
  toBackendConfluenceManifest,
} from "../src";

// The Confluence manifest always uses the platform's standard OAuth2 flow; this
// narrows the manifest's auth union so its OAuth2 fields can be read.
function oauth2Auth(manifest: ConnectorManifest) {
  assert.equal(manifest.auth.kind, "oauth2");
  if (manifest.auth.kind !== "oauth2") throw new Error("unreachable");
  return manifest.auth;
}

const root = new URL("../", import.meta.url);

function backendManifest() {
  return toBackendConfluenceManifest({
    clientId: "app",
    redirectUri: "https://sourceweft.example/callback",
  });
}

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinConfluenceConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinConfluenceConnectorCapabilityManifest);
});

test("backend manifest exposes the five scopes, auth params, empty sync resources and selection", () => {
  const manifest = backendManifest();

  assert.equal(manifest.type, "confluence");
  assert.deepEqual(manifest.auth.scopes, [...CONFLUENCE_SCOPES]);
  assert.deepEqual(manifest.auth.scopes, [
    "read:space:confluence",
    "read:page:confluence",
    "read:content-details:confluence",
    "read:me",
    "offline_access",
  ]);
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
      browse: "confluence.browse",
      search: "confluence.search",
      describe: "confluence.describe",
    },
    kinds: ["site", "space", "page"],
    maxItems: 100,
  });
});

test("the manifest declares three internal selection actions and three agent actions", () => {
  const manifest = backendManifest();

  assert.equal(manifest.actions.length, 6);
  const internal = manifest.actions.filter(
    (action) => action.visibility === "internal",
  );
  const agent = manifest.actions.filter(
    (action) => action.visibility === "agent",
  );
  assert.deepEqual(internal.map((action) => action.type).sort(), [
    "confluence.browse",
    "confluence.describe",
    "confluence.search",
  ]);
  assert.deepEqual(
    agent.map((action) => [action.type, action.agentToolName]).sort(),
    [
      ["confluence.content.search", "search_confluence"],
      ["confluence.page.read", "read_confluence_page"],
      ["confluence.space.list", "list_confluence_spaces"],
    ],
  );
  for (const action of manifest.actions) {
    assert.deepEqual(action.capabilities, ["connector_read"]);
    assert.equal(action.riskLevel, "low");
    assert.equal(action.requiresApproval, false);
  }
});

test("every agent action input property carries a description and no extra properties are allowed", () => {
  for (const action of confluenceConnectorContribution.actions) {
    const schema = action.inputSchema as {
      additionalProperties: boolean;
      properties: Record<string, { description?: string }>;
    };
    assert.equal(schema.additionalProperties, false, action.id);
    if (action.visibility !== "agent") continue;
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.ok(
        typeof property.description === "string" && property.description !== "",
        `${action.id}.${name} needs a description`,
      );
    }
  }
});

test("agent action inputs match the published schema", () => {
  const byId = new Map(
    confluenceConnectorContribution.actions.map((action) => [action.id, action]),
  );
  assert.deepEqual(byId.get("confluence.content.search")?.inputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Words to search for in page titles and bodies.",
      },
      spaceKeys: {
        type: "array",
        maxItems: 20,
        items: { type: "string", pattern: "^[A-Za-z0-9_~.-]{1,255}$" },
        description:
          'Limit the search to these space keys (for example ["ENG"]). Use keys from list_confluence_spaces; a key that is not selected matches nothing.',
      },
      updatedWithinDays: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description: "Only pages updated in the last N days (1 to 365).",
      },
      cursor: {
        type: "string",
        maxLength: 4096,
        description:
          "Pass the previous result's nextCursor with the same other parameters to get the next page.",
      },
    },
  });
  assert.deepEqual(byId.get("confluence.page.read")?.inputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: {
        type: "string",
        pattern: "^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:)?[0-9]{1,20}$",
        description:
          'The page id from a search result, for example "<cloudId>:123456", or a bare numeric page id.',
      },
    },
  });
  assert.deepEqual(byId.get("confluence.space.list")?.inputSchema, {
    type: "object",
    additionalProperties: false,
    properties: {},
  });
});

test("the config schema accepts only space and page items, at most 100, without duplicates", () => {
  const schema = confluenceConnectorContribution.configSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.default, { items: [] });
  const items = schema.properties.items;
  assert.equal(items.maxItems, CONFLUENCE_MAX_SELECTED_ITEMS);
  assert.equal(CONFLUENCE_MAX_SELECTED_ITEMS, 100);
  assert.equal(items.uniqueItems, true);
  assert.deepEqual(items.items.required, ["id", "kind"]);
  assert.deepEqual(items.items.properties.kind.enum, ["space", "page"]);
  const idPattern = items.items.properties.id.pattern;
  const cloudId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.ok(new RegExp(idPattern).test(`space:${cloudId}:1`));
  assert.ok(new RegExp(idPattern).test(`page:${cloudId}:1`));
  assert.ok(!new RegExp(idPattern).test(`site:${cloudId}`));
});

test("the id patterns match only their own kind", () => {
  const cloudId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.ok(new RegExp(CONFLUENCE_SPACE_ID_PATTERN).test(`space:${cloudId}:98304`));
  assert.ok(!new RegExp(CONFLUENCE_SPACE_ID_PATTERN).test(`page:${cloudId}:1`));
  assert.ok(new RegExp(CONFLUENCE_PAGE_ID_PATTERN).test(`page:${cloudId}:123`));
  assert.ok(!new RegExp(CONFLUENCE_PAGE_ID_PATTERN).test(`space:${cloudId}:1`));
  assert.ok(new RegExp(CONFLUENCE_SITE_ID_PATTERN).test(`site:${cloudId}`));
  assert.ok(!new RegExp(CONFLUENCE_SITE_ID_PATTERN).test(`site:${cloudId}:1`));
});

test("the backend manifest parses and its selection agrees with the contribution", () => {
  // The backend `connectorSelectionSpecSchema` and the contribution's
  // `connectorSelectionSpecSchema` are defined separately in two packages
  // that do not depend on each other; this guards that they agree on a real
  // manifest.
  const parsed = connectorManifestSchema.parse(backendManifest());
  assert.deepEqual(
    parsed.selection,
    confluenceConnectorContribution.selection,
  );
});
