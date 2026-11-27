import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityManifestSchema,
  connectorContributionSchema,
} from "@sourceweft/capability-contracts";
import { loadCapabilityManifestFixture } from "@sourceweft/capability-contracts/testing";
import { connectorManifestSchema } from "@sourceweft/contracts";
import {
  builtinWordPressConnectorCapabilityManifest,
  toBackendWordPressLoginManifest,
  toBackendWordPressManifest,
  wordpressConnectorContribution,
  wordpressLoginConnectorContribution,
} from "../src";

const root = new URL("../", import.meta.url);

test("JSON capability manifest matches the TypeScript export", async () => {
  const { raw } = await loadCapabilityManifestFixture(root);
  assert.deepEqual(raw, builtinWordPressConnectorCapabilityManifest);
  capabilityManifestSchema.parse(builtinWordPressConnectorCapabilityManifest);
});

test("the capability declares both WordPress connectors under one identity", () => {
  const manifest = builtinWordPressConnectorCapabilityManifest;
  assert.equal(manifest.id, "sourceweft/wordpress");
  assert.equal(manifest.kind, "connector");
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(
    manifest.connectors.map((c) => c.id),
    ["wordpress", "wordpress_login"],
  );
});

test("both contributions parse and share the sync and selection shape", () => {
  for (const [id, title, contribution] of [
    ["wordpress", "WordPress site", wordpressConnectorContribution],
    [
      "wordpress_login",
      "WordPress site (login)",
      wordpressLoginConnectorContribution,
    ],
  ] as const) {
    assert.equal(contribution.id, id);
    assert.equal(contribution.title, title);
    assert.equal(contribution.sync.supportsIncremental, false);
    assert.equal(contribution.sync.defaultFrequencyMinutes, 360);
    assert.equal(contribution.sync.minFrequencyMinutes, 60);
    assert.deepEqual(contribution.sync.resources, [
      {
        type: "wordpress_content",
        title: "Post or page",
        supportsDeleteDetection: true,
      },
    ]);
    assert.deepEqual(contribution.selection, {
      actions: {
        browse: `${id}.browse`,
        search: `${id}.search`,
        describe: `${id}.describe`,
      },
      kinds: ["type", "category", "post", "page"],
      maxItems: 500,
    });
    assert.deepEqual(
      contribution.actions.map((a) => a.id),
      [`${id}.browse`, `${id}.search`, `${id}.describe`],
    );
    for (const action of contribution.actions) {
      assert.equal(action.visibility, "internal");
      assert.equal(action.risk, "low");
      assert.equal(action.requiresApproval, false);
      assert.deepEqual(action.capabilities, ["connector_read"]);
    }
    connectorContributionSchema.parse(contribution);
  }
});

test("the auth kinds differ: none for the public site, basic credential for the login site", () => {
  assert.deepEqual(wordpressConnectorContribution.auth, { kind: "none" });
  assert.deepEqual(wordpressLoginConnectorContribution.auth, {
    kind: "credential",
    scheme: "basic",
  });
});

test("backend manifests carry the matching auth and selection specs", () => {
  const publicManifest = connectorManifestSchema.parse(
    toBackendWordPressManifest(),
  );
  assert.equal(publicManifest.type, "wordpress");
  assert.equal(publicManifest.displayName, "WordPress site");
  assert.deepEqual(publicManifest.auth, { kind: "none" });
  assert.equal(publicManifest.sync.resources[0]!.type, "wordpress_content");
  assert.deepEqual(
    publicManifest.actions.map((a) => a.type),
    ["wordpress.browse", "wordpress.search", "wordpress.describe"],
  );
  assert.equal(publicManifest.selection?.actions.search, "wordpress.search");
  assert.equal(publicManifest.selection?.maxItems, 500);

  const loginManifest = connectorManifestSchema.parse(
    toBackendWordPressLoginManifest(),
  );
  assert.equal(loginManifest.type, "wordpress_login");
  assert.equal(loginManifest.displayName, "WordPress site (login)");
  assert.deepEqual(loginManifest.auth, { kind: "credential", scheme: "basic" });
  assert.deepEqual(
    loginManifest.actions.map((a) => a.type),
    [
      "wordpress_login.browse",
      "wordpress_login.search",
      "wordpress_login.describe",
    ],
  );
  assert.equal(
    loginManifest.selection?.actions.describe,
    "wordpress_login.describe",
  );
});
