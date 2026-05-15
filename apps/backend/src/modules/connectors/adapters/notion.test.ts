import assert from "node:assert/strict";
import test from "node:test";
import { notionAdapter } from "./notion";

test("notion adapter declares install-integration OAuth manifest", () => {
  const manifest = notionAdapter.getManifest();

  assert.equal(manifest.type, "notion");
  assert.equal(
    manifest.auth.authorizationUrl,
    "https://www.notion.so/install-integration",
  );
  assert.equal(manifest.auth.tokenUrl, "https://api.notion.com/v1/oauth/token");
  assert.deepEqual(manifest.auth.scopes, []);
  assert.equal(manifest.auth.sendScope, false);
  assert.deepEqual(manifest.auth.authorizationParams, { owner: "user" });
  assert.ok(
    manifest.actions.some((action) => action.type === "notion.page.create"),
  );
  assert.ok(
    manifest.sync.resources.some(
      (resource) => resource.type === "notion_page",
    ),
  );
});

test("notion action schemas require approval for writes", () => {
  const manifest = notionAdapter.getManifest();
  const writeActions = manifest.actions.filter(
    (action) => action.type !== "notion.data_source.query",
  );

  assert.ok(writeActions.length > 0);
  for (const action of writeActions) {
    assert.equal(action.requiresApproval, true);
  }
});
