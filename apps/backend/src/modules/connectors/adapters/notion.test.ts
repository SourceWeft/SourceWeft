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
    (action) =>
      action.type !== "notion.data_source.query" &&
      action.type !== "notion.page.find",
  );

  assert.ok(writeActions.length > 0);
  for (const action of writeActions) {
    assert.equal(action.requiresApproval, true);
  }
});

test("notion adapter declares expanded actions", () => {
  const actionTypes = new Set(
    notionAdapter.getManifest().actions.map((action) => action.type),
  );

  assert.ok(actionTypes.has("notion.page.find"));
  assert.ok(actionTypes.has("notion.page.update_by_title"));
  assert.ok(actionTypes.has("notion.page.trash_by_title"));
  assert.ok(actionTypes.has("notion.file_upload.create"));
  assert.ok(actionTypes.has("notion.file_upload.attach_to_page"));
});

test("notion webhook parser maps page update to targeted sync", async () => {
  assert.ok(notionAdapter.parseWebhookEvent);
  assert.ok(notionAdapter.mapWebhookEventToSyncTargets);

  const event = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      id: "evt_1",
      type: "page.content_updated",
      workspace_id: "workspace_1",
      data: {
        object: "page",
        id: "page_1",
      },
    }),
  });
  const targets = await notionAdapter.mapWebhookEventToSyncTargets(event);

  assert.equal(event.providerEventId, "evt_1");
  assert.equal(event.workspaceHint, "workspace_1");
  assert.deepEqual(targets, [
    {
      action: "sync",
      externalId: "page:page_1",
      objectId: "page_1",
      objectType: "page",
    },
  ]);
});

test("notion webhook parser records verification token", async () => {
  assert.ok(notionAdapter.parseWebhookEvent);
  assert.ok(notionAdapter.mapWebhookEventToSyncTargets);

  const event = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      verification_token: "verify-me",
      workspace_id: "workspace_1",
    }),
  });
  const targets = await notionAdapter.mapWebhookEventToSyncTargets(event);

  assert.equal(event.eventType, "webhook.verification");
  assert.equal(event.metadata.verificationToken, "verify-me");
  assert.deepEqual(targets, [{ action: "record_only", reason: "verification" }]);
});

test("notion webhook verification rejects bad signature when secret is configured", async () => {
  assert.ok(notionAdapter.verifyWebhook);
  const verifyWebhook = notionAdapter.verifyWebhook;
  const previousSecret = process.env.NOTION_WEBHOOK_SECRET;
  process.env.NOTION_WEBHOOK_SECRET = "secret";
  await assert.rejects(
    () =>
      verifyWebhook({
        headers: { "x-notion-signature": "sha256=bad" },
        query: {},
        rawBody: "{}",
      }),
    /Notion webhook signature is invalid/,
  );
  if (previousSecret === undefined) {
    delete process.env.NOTION_WEBHOOK_SECRET;
  } else {
    process.env.NOTION_WEBHOOK_SECRET = previousSecret;
  }
});

test("notion webhook parser maps delete to archive source", async () => {
  assert.ok(notionAdapter.parseWebhookEvent);
  assert.ok(notionAdapter.mapWebhookEventToSyncTargets);

  const event = await notionAdapter.parseWebhookEvent({
    headers: {},
    query: {},
    rawBody: JSON.stringify({
      id: "evt_2",
      type: "data_source.deleted",
      workspace_id: "workspace_1",
      data: {
        object: "data_source",
        id: "ds_1",
      },
    }),
  });
  const targets = await notionAdapter.mapWebhookEventToSyncTargets(event);

  assert.deepEqual(targets, [
    {
      action: "archive_source",
      externalId: "data_source:ds_1",
      objectId: "ds_1",
      objectType: "data_source",
    },
  ]);
});
